// Public content pages (MVP-001 S5; MBS sections 17 and 18.1; MVP-001 Packet
// rule 11 and the section 3 gate "Public content, Privacy, Terms,
// disclosures": unapproved content is not rendered).
//
// Pure and deterministic. The renderer fails closed: no public content,
// legal text or disclosure is approved, and this module holds none, so every
// known topic resolves only to its title and the fixed statement that its
// information is not yet available. Any other topic is not found. Approved
// content would arrive through its own approved source in a later change;
// nothing here can render text that has not been approved.

export const PUBLIC_CONTENT_TOPICS = Object.freeze({
  "how-it-works": "How Rosuno works",
  "for-attorneys": "For attorneys",
  about: "About",
  contact: "Contact",
  terms: "Terms",
  disclosures: "Disclosures",
} as const);

export type PublicContentTopic = keyof typeof PUBLIC_CONTENT_TOPICS;

export type PublicContentView =
  | {
      readonly status: "not-available";
      readonly title: string;
      readonly statement: string;
    }
  | { readonly status: "not-found" };

const NOT_FOUND = Object.freeze({ status: "not-found" } as const);

export function publicContentOf(topic: unknown): PublicContentView {
  if (
    typeof topic !== "string" ||
    !Object.hasOwn(PUBLIC_CONTENT_TOPICS, topic)
  ) {
    return NOT_FOUND;
  }
  const title = PUBLIC_CONTENT_TOPICS[topic as PublicContentTopic];
  return Object.freeze({
    status: "not-available",
    title,
    statement: `${title} information is not yet available.`,
  });
}
