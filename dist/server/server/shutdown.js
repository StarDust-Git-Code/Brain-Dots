export function createShutdown(options) {
    let pending;
    return () => (pending ??= (async () => {
        let failed = false;
        const report = (operation, error) => {
            failed = true;
            options.report(operation, error);
        };
        try {
            options.stopRunner();
        }
        catch (error) {
            report('Stopping scheduler failed', error);
        }
        let timer;
        const deadline = new Promise((resolve) => {
            timer = setTimeout(() => {
                report('Shutdown deadline exceeded', new Error('Timeout'));
                resolve();
            }, options.timeoutMs ?? 8000);
        });
        const settle = async (operation, action) => {
            try {
                await action();
            }
            catch (error) {
                report(operation, error);
            }
        };
        await Promise.race([
            Promise.all([
                settle('Stopping Channels failed', options.stopPlatform),
                settle('Closing HTTP server failed', options.closeServer),
            ]),
            deadline,
        ]);
        clearTimeout(timer);
        options.exit(failed ? 1 : 0);
    })());
}
