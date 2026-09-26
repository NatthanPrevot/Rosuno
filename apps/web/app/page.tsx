import { connection } from "next/server";
import { getShellView } from "../src/application/shell.ts";

export default async function HomePage() {
  // Session state belongs to each request on the server; never prerender it.
  await connection();
  const view = await getShellView();
  return (
    <>
      <h1>Rosuno</h1>
      <p>Session: {view.session}</p>
    </>
  );
}
