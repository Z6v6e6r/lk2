export const SUPPORT_TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_USER',
  'RESOLVED',
  'CLOSED',
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];
export const SUPPORT_TICKET_CATEGORIES = [
  'TECHNICAL',
  'ACCOUNT',
  'BOOKING',
  'BILLING',
  'OTHER',
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];
export const SUPPORT_TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];
