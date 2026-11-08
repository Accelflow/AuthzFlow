# Group coordination port v1

One owner polls each authority/binding/Resource Group in a shared store. An atomic
storage transaction owns monotonically increasing owner terms, lease expiry,
Group checkpoint and fan-out intents. Resource reads use a local session-bound
permit and shared Group generation; owner election does not transfer permits.

Notifications only request a shared-store reload. Missing, duplicated, reordered
or forged notifications cannot grant. Every protected read checks shared state
before work and at final delivery. No store access means no read. Background
display suspension and previously returned plaintext cannot be recalled.

Old owner commits and purge jobs must compare term and Group/Resource generation
inside their write/delete transaction. The purge port receives an asynchronous
guard to run in that transaction. Calling it once before unrelated asynchronous
work is insufficient. Dirty outcomes retain a durable intent and do not stop
other Resource invalidations or subsequent pages.

Owner lease defaults: 15 seconds, renew/poll every 5 seconds. Host time must be
trusted and nondecreasing; CAS/terms enforce safety even if timers are delayed.
Web uses IndexedDB transactions with optional Web Locks and BroadcastChannel as a
wakeup. PC uses its main service and SQLite transactions with trusted IPC. Native
hosts may supply this port; no OS-specific multiprocess adapter is implied.

Use a deployment-specific namespace to separate authorities and databases. Close
releases only its own term. Durable fences/intents survive close and restart.
