// Imported first by index.mjs so that it runs before sharp (or anything else)
// touches the libuv threadpool, whose size is fixed on first use.
import {availableParallelism} from 'os';

import dotenv from 'dotenv';

dotenv.config({quiet: true});

export const threadLimit = isNaN(parseInt(process.env.THREAD_LIMIT))
    ? availableParallelism()
    : parseInt(process.env.THREAD_LIMIT);

// sharp runs each image operation on a libuv threadpool thread; the pool
// defaults to 4 threads, which would cap tile encoding parallelism.
if (!process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = String(Math.max(4, threadLimit));
}
