export class WorkerTaskExecutorError extends Error {
  override readonly name: string = "WorkerTaskExecutorError";
}

export class WorkerTaskTimeoutError extends WorkerTaskExecutorError {
  override readonly name: string = "WorkerTaskTimeoutError";
}

export class WorkerTaskCancelledError extends WorkerTaskExecutorError {
  override readonly name: string = "WorkerTaskCancelledError";
}
