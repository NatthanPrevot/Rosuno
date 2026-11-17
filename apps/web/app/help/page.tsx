// Help entry point (MVP-001 S3 part 2; MBS section 18 "FAQ / Help" and
// "Help / Complaints"; MVP-001 Packet rule 11 and the section 3 gate
// "Public content, Privacy, Terms, disclosures": unapproved content is not
// rendered).
//
// A fixed public page, the same for everyone. No help content is approved
// yet, so the page says only that the information is not yet available. It
// reads nothing and decides nothing.

import type { Metadata } from "next";

import {
  ButtonLink,
  Cluster,
  Eyebrow,
  Heading,
  Page,
  Stack,
  Surface,
  Text,
} from "../../src/presentation/design-system.tsx";

export const metadata: Metadata = {
  title: "Help",
};

export default function HelpPage() {
  return (
    <Page density="public">
      <Surface emphasis="raised" labelledBy="help-title">
        <Stack>
          <Eyebrow>Rosuno</Eyebrow>
          <Heading as="h1" size="lg" id="help-title">
            Help
          </Heading>
          <Text>Help information is not yet available.</Text>
          <Cluster>
            <ButtonLink variant="tertiary" href="/">
              Return to the home page
            </ButtonLink>
          </Cluster>
        </Stack>
      </Surface>
    </Page>
  );
}
