// Website and appearance studio: a page text slot (DEV-001; studio
// specification section 2.6).
//
// Renders a registry slot's text: the configuration's override when it
// passes the slot's rules again here (length, lines, plain text, no link or
// regulated phrase), else the design's own default, which is byte-equal to
// the text the page rendered before slots existed. The text is only ever
// React text nodes; a line break in the text becomes a <br /> element, made
// here. No markup, attribute or style ever comes from a configuration.

import { Fragment, type ReactNode } from "react";

import {
  slotTextOf,
  type AppearanceConfiguration,
} from "../../application/appearance-schema.ts";
import { slotSpecOf, type HomeSlotId } from "./registry.ts";

export function SlotText({
  appearance,
  id,
}: {
  readonly appearance: AppearanceConfiguration | null;
  readonly id: HomeSlotId;
}): ReactNode {
  const lines = slotTextOf(appearance, slotSpecOf(id)).split("\n");
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}
