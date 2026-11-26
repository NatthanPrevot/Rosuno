import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Rosuno",
};

// Root layout shared by every route and boundary. DEV-001 website and
// appearance studio: the published appearance stylesheet is a constant
// same-origin link (React places it in the head); it is empty until a
// version is published, and the layout reads no data.
export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <link
          rel="stylesheet"
          href="/appearance/theme.css"
          precedence="rosuno-appearance"
        />
        <main>{children}</main>
      </body>
    </html>
  );
}
