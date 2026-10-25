mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/number-watcher-test" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:number-watcher-failures" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:number-watcher-test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:function:number-watcher" }
  }
}

run "default_stack" {
  command = plan
  assert {
    condition     = aws_lambda_function.worker.runtime == "nodejs24.x" && aws_lambda_function.worker.timeout == 120
    error_message = "Use the supported Node runtime and a bounded invocation."
  }
  assert {
    condition     = aws_dynamodb_table.jobs.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.jobs.ttl[0].attribute_name == "ttl"
    error_message = "Use on-demand storage and lease-only TTL."
  }
  assert {
    condition     = length(aws_lambda_function.worker.vpc_config) == 0
    error_message = "This worker does not need a VPC or NAT gateway."
  }
  assert {
    condition     = aws_lambda_function.worker.environment[0].variables.CREDENTIALS_SECRET_ARN == aws_secretsmanager_secret.credentials[0].arn
    error_message = "Pass a secret reference, never credentials, into the Lambda configuration."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.worker.destination_config[0].on_failure[0].destination == aws_sqs_queue.failures.arn
    error_message = "Failed asynchronous invocations must reach the failure queue."
  }
}

run "existing_secret" {
  command = plan
  variables {
    credentials_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:existing-test"
  }
  assert {
    condition     = length(aws_secretsmanager_secret.credentials) == 0 && output.credentials_secret_arn == var.credentials_secret_arn
    error_message = "An existing secret must not create a second secret."
  }
}
