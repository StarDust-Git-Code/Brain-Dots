// Message IDs survive Intelligence history replay even when metadata does not.
export const scheduledTaskMessagePrefix = 'opendots:scheduled_task:';
export function isScheduledTaskMessage(message) {
    if (message.role !== 'user')
        return false;
    if (message.id.startsWith(scheduledTaskMessagePrefix))
        return true;
    const metadata = message.metadata;
    return (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'scheduled_task');
}
