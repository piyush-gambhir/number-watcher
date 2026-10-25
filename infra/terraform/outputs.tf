output "function_name" { value = aws_lambda_function.worker.function_name }
output "function_arn" { value = aws_lambda_function.worker.arn }
output "credentials_secret_arn" { value = local.secret_arn }
output "jobs_table" { value = aws_dynamodb_table.jobs.name }
output "schedule_group" { value = aws_scheduler_schedule_group.jobs.name }
output "failure_queue_url" { value = aws_sqs_queue.failures.url }
output "log_group" { value = aws_cloudwatch_log_group.worker.name }
