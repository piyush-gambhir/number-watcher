data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  secret_arn   = var.credentials_secret_arn != null ? var.credentials_secret_arn : aws_secretsmanager_secret.credentials[0].arn
  function_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${var.name}"
  schedule_arn = "arn:${data.aws_partition.current.partition}:scheduler:${var.region}:${data.aws_caller_identity.current.account_id}:schedule/${var.name}/job-*"
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../../build/lambda"
  output_path = "${path.module}/../../build/number-watcher-lambda.zip"
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${var.name}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  server_side_encryption { enabled = true }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  # Only leases have a TTL. Purchase checkpoints must survive job expiry.
  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "credentials" {
  count                   = var.credentials_secret_arn == null ? 1 : 0
  name                    = "${var.name}/credentials"
  description             = "Number Watcher provider and notification environment variables as JSON"
  recovery_window_in_days = 7
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_sqs_queue" "failures" {
  name                      = "${var.name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_scheduler_schedule_group" "jobs" { name = var.name }

resource "aws_iam_role" "scheduler" {
  name = "${var.name}-scheduler"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = {
      StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id },
      ArnEquals    = { "aws:SourceArn" = aws_scheduler_schedule_group.jobs.arn }
    }
  }] })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = local.function_arn },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.failures.arn }
  ] })
}

resource "aws_iam_role" "worker" {
  name = "${var.name}-worker"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.worker.arn}:*" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.jobs.arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = local.secret_arn },
    { Effect = "Allow", Action = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"], Resource = local.schedule_arn },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = aws_iam_role.scheduler.arn,
    Condition = { StringEquals = { "iam:PassedToService" = "scheduler.amazonaws.com" } } },
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.failures.arn }
  ] })
}

resource "aws_lambda_function" "worker" {
  function_name = var.name
  description   = "One polling round for a durable phone number acquisition request"
  role          = aws_iam_role.worker.arn
  runtime       = "nodejs24.x"
  architectures = ["x86_64"]
  handler       = "index.handler"
  filename      = data.archive_file.lambda.output_path
  code_sha256   = data.archive_file.lambda.output_base64sha256
  memory_size   = var.memory_size
  timeout       = 120
  environment {
    variables = {
      NUMBER_WATCHER_TABLE   = aws_dynamodb_table.jobs.name
      CREDENTIALS_SECRET_ARN = local.secret_arn
      SCHEDULE_GROUP         = aws_scheduler_schedule_group.jobs.name
      SCHEDULE_ROLE_ARN      = aws_iam_role.scheduler.arn
      DLQ_ARN                = aws_sqs_queue.failures.arn
    }
  }
  depends_on = [aws_iam_role_policy.worker, aws_iam_role_policy.scheduler, aws_cloudwatch_log_group.worker]
}

resource "aws_lambda_function_event_invoke_config" "worker" {
  function_name                = aws_lambda_function.worker.function_name
  maximum_event_age_in_seconds = 300
  maximum_retry_attempts       = 2
  destination_config {
    on_failure { destination = aws_sqs_queue.failures.arn }
  }
}

resource "aws_cloudwatch_metric_alarm" "failures" {
  alarm_name          = "${var.name}-undelivered-invocations"
  alarm_description   = "Inspect the failure queue and saved job status. Alarm actions can be connected to your monitoring."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.failures.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
