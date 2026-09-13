/** Cooperative CPU/upload budget. A task or driver call cannot be preempted. */
export class FrameBudget {
  constructor({
    frameBudgetMs = 2,
    uploadBudgetBytes = 8 * 1024 * 1024,
    signal,
    metrics = {},
    now = () => performance.now(),
    yieldFrame,
  } = {}) {
    if (
      !Number.isFinite(frameBudgetMs) ||
      frameBudgetMs < 0 ||
      !Number.isSafeInteger(uploadBudgetBytes) ||
      uploadBudgetBytes < 1
    )
      throw new Error("Invalid frame budget");
    Object.assign(this, {
      frameBudgetMs,
      uploadBudgetBytes,
      signal,
      metrics,
      now,
    });
    this.spent = 0;
    this.bytes = 0;
    this.yieldFrame =
      yieldFrame ||
      (() =>
        new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (typeof cancelAnimationFrame === "function")
              cancelAnimationFrame(raf);
            resolve();
          };
          const raf =
            typeof requestAnimationFrame === "function"
              ? requestAnimationFrame(finish)
              : null;
          const timer = setTimeout(finish, 50);
        }));
    Object.assign(metrics, {
      cpuWorkMs: 0,
      maxTaskMs: 0,
      maxSliceMs: 0,
      budgetYields: 0,
      uploadBytes: 0,
    });
  }
  async run(task, uploadBytes = 0) {
    this.signal?.throwIfAborted();
    if (
      this.frameBudgetMs &&
      (this.spent >= this.frameBudgetMs ||
        this.bytes + uploadBytes > this.uploadBudgetBytes)
    ) {
      await this.yieldFrame();
      this.signal?.throwIfAborted();
      this.spent = 0;
      this.bytes = 0;
      this.metrics.budgetYields++;
    }
    const start = this.now();
    const value = task();
    const elapsed = this.now() - start;
    this.spent += elapsed;
    this.bytes += uploadBytes;
    this.metrics.cpuWorkMs += elapsed;
    this.metrics.uploadBytes += uploadBytes;
    this.metrics.maxTaskMs = Math.max(this.metrics.maxTaskMs, elapsed);
    this.metrics.maxSliceMs = Math.max(this.metrics.maxSliceMs, this.spent);
    return value;
  }
}
