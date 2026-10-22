/** Host computes these flags from its own durable journal inside the purge transaction. */
export function canPurgeReplica(input: {
    pendingWrites: boolean;
    inFlight: boolean;
    conflicts: boolean;
    holds: boolean;
    unresolvedSources: boolean;
    contentChanged: boolean;
}): boolean {
    const { pendingWrites, inFlight, conflicts, holds, unresolvedSources, contentChanged } = input;
    return !pendingWrites && !inFlight && !conflicts && !holds && !unresolvedSources && !contentChanged;
}
