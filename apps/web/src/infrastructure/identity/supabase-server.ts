import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

const REQUIRED_CACHE_HEADERS = ["cache-control", "expires", "pragma"] as const;

type SupabaseConfiguration = {
  readonly url: string;
  readonly publishableKey: string;
};

function readSupabaseConfiguration(): SupabaseConfiguration | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (
    typeof url !== "string" ||
    url.trim() === "" ||
    typeof publishableKey !== "string" ||
    publishableKey.trim() === ""
  ) {
    return null;
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }

  return Object.freeze({
    url,
    publishableKey,
  });
}

export async function createSupabaseServerClient() {
  const configuration = readSupabaseConfiguration();

  if (configuration === null) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, _headers) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies.
          // Proxy owns refresh writes.
        }
      },
    },
  });
}

export async function refreshSupabaseSession(
  request: NextRequest,
): Promise<NextResponse> {
  let response = NextResponse.next({
    request,
  });

  const configuration = readSupabaseConfiguration();

  if (configuration === null) {
    return response;
  }

  try {
    const supabase = createServerClient(
      configuration.url,
      configuration.publishableKey,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet, headers) {
            cookiesToSet.forEach(({ name, value }) => {
              request.cookies.set(name, value);
            });

            response = NextResponse.next({
              request,
            });

            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });

            for (const [name, value] of Object.entries(headers)) {
              const normalizedName = name.toLowerCase();

              if (
                REQUIRED_CACHE_HEADERS.some(
                  (required) => required === normalizedName,
                )
              ) {
                response.headers.set(normalizedName, value);
              }
            }
          },
        },
      },
    );

    await supabase.auth.getClaims();
  } catch {
    // Authentication remains untrusted here.
    // The session adapter independently fails closed.
  }

  return response;
}
