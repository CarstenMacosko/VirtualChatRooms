import { z } from "zod";

/** Contacts, contact groups and the friend codes people use to find each other. */

/** 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const FriendCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    new RegExp(`^[${FRIEND_CODE_ALPHABET}]{8}$`),
    "That isn't a friend code. Codes are 8 characters and never use 0, 1, O, I or L.",
  );

export const Contact = z.object({
  userId: z.string(),
  displayName: z.string(),
  /** Your own name for them, e.g. "Mom". */
  label: z.string().nullable(),
  online: z.boolean(),
});
export type Contact = z.infer<typeof Contact>;

export const ContactRequest = z.object({
  userId: z.string(),
  displayName: z.string(),
});
export type ContactRequest = z.infer<typeof ContactRequest>;

export const ContactGroup = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
});
export type ContactGroup = z.infer<typeof ContactGroup>;

export const ContactsResponse = z.object({
  contacts: z.array(Contact),
  incoming: z.array(ContactRequest),
  outgoing: z.array(ContactRequest),
  groups: z.array(ContactGroup),
});
export type ContactsResponse = z.infer<typeof ContactsResponse>;

export const AddContactRequest = z.object({ friendCode: FriendCode });
export type AddContactRequest = z.infer<typeof AddContactRequest>;

export const UpdateContactRequest = z.object({
  label: z.string().trim().max(40).nullable(),
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequest>;

export const SaveGroupRequest = z.object({
  name: z.string().trim().min(1).max(40),
  memberIds: z.array(z.string()).max(200),
});
export type SaveGroupRequest = z.infer<typeof SaveGroupRequest>;
