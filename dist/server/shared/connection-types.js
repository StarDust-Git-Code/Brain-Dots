import { z } from 'zod';
export const APPROVAL_TTL_MS = 60 * 60_000;
export const connectionActionSchema = z
    .object({
    approvalId: z.string().min(1).max(64),
    summary: z.string().trim().min(1).max(500),
})
    .strict();
export const connectionActionTool = {
    name: 'request_connection_action',
    description: 'Ask the owner to approve a connected-service action that changes something (sends, creates, updates, deletes). Use only after a connection tool returned approval_required. Pass its approvalId and a one-sentence summary of the effect. Call once, then wait: the result contains the service response if approved.',
    parameters: z.toJSONSchema(connectionActionSchema),
};
