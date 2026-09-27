import { connection } from "next/server";
import { getShellView } from "../src/application/shell.ts";
import {
  Alert,
  Button,
  Choice,
  Cluster,
  Columns,
  Dialog,
  DialogActions,
  DialogBody,
  DialogDismissal,
  Disclosure,
  Display,
  Eyebrow,
  FieldGroup,
  Heading,
  MediaFrame,
  Page,
  Rule,
  SelectField,
  Stack,
  Status,
  Surface,
  Table,
  Text,
  TextAreaField,
  TextField,
} from "../src/presentation/design-system.tsx";

export default async function HomePage() {
  // Session state belongs to each request on the server; never prerender it.
  await connection();
  const view = await getShellView();
  return (
    <Page density="public">
      <Surface as="header" tone="dark" emphasis="raised">
        <Stack>
          <Eyebrow>Interface foundation</Eyebrow>
          <Display as="h1">Rosuno</Display>
          <Text size="lede" tone="muted">
            One visual language for every Rosuno screen: warm surfaces,
            restrained gold, and clear hierarchy.
          </Text>
          <Rule tone="gold" />
          <Status tone="neutral">Session: {view.session}</Status>
        </Stack>
      </Surface>
      <Columns columns="split">
        <Stack>
          <Heading size="lg">Actions and status</Heading>
          <Text tone="muted">
            Three levels of emphasis, each with hover, focus, pressed, and
            disabled states.
          </Text>
          <Cluster>
            <Button variant="primary">Primary action</Button>
            <Button variant="secondary">Secondary action</Button>
            <Button variant="tertiary">Tertiary action</Button>
            <Button variant="secondary" disabled>
              Unavailable action
            </Button>
          </Cluster>
          <Text tone="muted">
            Status meaning is always written out; tone adds a glyph and a color
            beside the text.
          </Text>
          <Cluster>
            <Status tone="success">Success</Status>
            <Status tone="warning">Warning</Status>
            <Status tone="error">Error</Status>
            <Status tone="information">Information</Status>
          </Cluster>
          <Alert tone="information" title="Information">
            An alert presents a message supplied by the caller with a semantic
            state.
          </Alert>
        </Stack>
        <Surface as="aside" tone="chocolate" emphasis="raised">
          <Stack gap="tight">
            <Eyebrow>Supporting surface</Eyebrow>
            <Heading as="h3" size="sm">
              Dark surfaces are used with intent
            </Heading>
            <Text size="small" tone="muted">
              Working screens stay light. Deep cocoa and chocolate mark selected
              moments, and narrow screens use less of them.
            </Text>
          </Stack>
        </Surface>
      </Columns>
      <Surface emphasis="raised">
        <Stack>
          <Heading size="lg">Form controls</Heading>
          <FieldGroup
            id="foundation-group"
            legend="Grouped fields"
            hint="Labels, hints, and messages are supplied by the caller."
          >
            <Columns columns="2">
              <TextField
                id="foundation-text"
                label="Text field"
                hint="Hint text guides the entry."
              />
              <SelectField
                id="foundation-select"
                label="Select"
                hint="Options are supplied by the caller."
              >
                <option>First option</option>
                <option>Second option</option>
              </SelectField>
            </Columns>
            <TextAreaField
              id="foundation-area"
              label="Text area"
              errors="Validation message supplied by the caller."
            />
            <Choice
              type="checkbox"
              label="Choice"
              hint="A selectable option with a supporting hint."
            />
            <Disclosure summary="More detail">
              <Text tone="muted">
                Secondary detail stays one step away until it is needed.
              </Text>
            </Disclosure>
          </FieldGroup>
        </Stack>
      </Surface>
      <Stack>
        <Heading size="lg">Tables</Heading>
        <Table id="foundation-table" caption="Surface tones">
          <thead>
            <tr>
              <th scope="col">Tone</th>
              <th scope="col">Palette</th>
              <th scope="col">Placement</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Light</th>
              <td>Warm White</td>
              <td>Content panels</td>
            </tr>
            <tr>
              <th scope="row">Cream</th>
              <td>Cream</td>
              <td>Canvas and summary blocks</td>
            </tr>
            <tr>
              <th scope="row">Dark</th>
              <td>Deep Cocoa</td>
              <td>Premium modules</td>
            </tr>
            <tr>
              <th scope="row">Chocolate</th>
              <td>Chocolate</td>
              <td>Supporting modules on wider screens</td>
            </tr>
          </tbody>
        </Table>
      </Stack>
      <Columns columns="split">
        <Stack>
          <Heading size="lg">Dialog</Heading>
          <Dialog
            id="foundation-dialog"
            title="Dialog frame"
            titleAs="h3"
            presentation="inline"
            open
          >
            <DialogBody>
              <Text tone="muted">
                A strong title, concise supporting content, one primary action,
                and a quiet dismissal path.
              </Text>
            </DialogBody>
            <DialogActions>
              <Button variant="primary">Primary action</Button>
            </DialogActions>
            <DialogDismissal>
              <Button variant="tertiary">Dismiss</Button>
            </DialogDismissal>
          </Dialog>
        </Stack>
        <Stack>
          <Heading size="lg">Media frame</Heading>
          <MediaFrame
            ratio="standard"
            overlay="scrim"
            caption="Crop, overlay, and framing for media supplied by the caller."
          />
        </Stack>
      </Columns>
    </Page>
  );
}
