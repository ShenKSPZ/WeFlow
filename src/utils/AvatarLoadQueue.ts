
// 全局头像加载队列管理器（限制并发，避免卡顿）
export class AvatarLoadQueue {
    private queue: Array<{ url: string; resolve: () => void; reject: (error: Error) => void }> = []
    private loading = new Map<string, Promise<void>>()
    private activeCount = 0
    private readonly maxConcurrent = 3
    private readonly delayBetweenBatches = 10

    private static instance: AvatarLoadQueue

    public static getInstance(): AvatarLoadQueue {
        if (!AvatarLoadQueue.instance) {
            AvatarLoadQueue.instance = new AvatarLoadQueue()
        }
        return AvatarLoadQueue.instance
    }

    async enqueue(url: string): Promise<void> {
        if (!url) return Promise.resolve()

        // 核心修复：防止重复并发请求同一个 URL
        const existingPromise = this.loading.get(url)
        if (existingPromise) {
            return existingPromise
        }

        const loadPromise = new Promise<void>((resolve, reject) => {
            this.queue.push({ url, resolve, reject })
            this.processQueue()
        })

        this.loading.set(url, loadPromise)
        loadPromise.finally(() => {
            this.loading.delete(url)
        })

        return loadPromise
    }

    private async processQueue() {
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
            return
        }

        const task = this.queue.shift()
        if (!task) return

        this.activeCount++

        const img = new Image()
        img.onload = () => {
            this.activeCount--
            task.resolve()
            setTimeout(() => this.processQueue(), this.delayBetweenBatches)
        }
        img.onerror = () => {
            this.activeCount--
            task.reject(new Error(`Failed: ${task.url}`))
            setTimeout(() => this.processQueue(), this.delayBetweenBatches)
        }
        img.src = task.url

        this.processQueue()
    }

    clear() {
        this.queue = []
        this.loading.clear()
        this.activeCount = 0
    }
}

export const avatarLoadQueue = AvatarLoadQueue.getInstance()
