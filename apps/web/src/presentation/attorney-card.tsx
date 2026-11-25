// The attorney card of the owner's UI/UX design (AttorneyCard: portrait
// first, details below), bound to one public directory entry.
//
// Presentation only. Every value is the caller's: the database's own public
// directory answer and the fixed first-party links built from it. No figure
// the directory does not answer (rating, review count, price) is shown, and
// no portrait is shown until consented images exist: the card shows the
// attorney's initials in the portrait area instead. The availability wording
// is the directory's own (discovery labels).

import {
  AVAILABLE_NOW,
  NO_AVAILABILITY_SHOWN,
  SCHEDULED_AVAILABILITY,
} from "./discovery-labels.ts";

export type AttorneyCardEntry = {
  readonly attorneyId: string;
  readonly displayName: string;
  readonly headline: string | null;
  readonly yearsExperience: number | null;
  readonly practiceAreas: readonly string[];
  readonly availableNow: boolean;
  readonly scheduledAvailability: boolean;
};

type AttorneyCardProps = {
  readonly entry: AttorneyCardEntry;
  // The jurisdiction the visitor chose; its name is the licensing line.
  readonly jurisdictionName: string;
  readonly profileHref: string;
  // The selection page for each request path the attorney offers now.
  readonly talkNowHref: string | null;
  readonly scheduleHref: string | null;
};

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /^[\p{L}]/u.test(part))
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function CalendarIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function AttorneyCard({
  entry,
  jurisdictionName,
  profileHref,
  talkNowHref,
  scheduleHref,
}: AttorneyCardProps) {
  const area = entry.practiceAreas[0] ?? null;
  return (
    <article className="rz acard" aria-label={entry.displayName}>
      <a className="portrait rz-portrait" href={profileHref} tabIndex={-1}>
        <span className="rz-portrait__initials" aria-hidden="true">
          {initialsOf(entry.displayName)}
        </span>
        {entry.availableNow ? (
          <span className="status now">
            <span className="dot" />
            {AVAILABLE_NOW}
          </span>
        ) : entry.scheduledAvailability ? (
          <span className="status">
            <CalendarIcon />
            {SCHEDULED_AVAILABILITY}
          </span>
        ) : (
          <span className="status l-cmuted">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="8" />
              <path d="M8 12h8" />
            </svg>
            {NO_AVAILABILITY_SHOWN}
          </span>
        )}
      </a>
      <div className="bd">
        <h3 className="name">
          <a href={profileHref}>{entry.displayName}</a>
        </h3>
        {area === null ? null : <p className="area">{area}</p>}
        {entry.headline === null ? null : (
          <p className="spec" title={entry.headline}>
            {entry.headline}
          </p>
        )}
        <div className="info">
          {entry.yearsExperience === null ? null : (
            <span className="i">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="7" width="18" height="13" rx="2.5" />
                <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12.5h18" />
              </svg>
              <span>
                {entry.yearsExperience === 1
                  ? "1 year’s experience"
                  : `${entry.yearsExperience} years’ experience`}
              </span>
            </span>
          )}
          <span className="i">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
              <circle cx="12" cy="9.5" r="2.5" />
            </svg>
            <span>Listed in {jurisdictionName}</span>
          </span>
        </div>
        <div className="acts">
          {talkNowHref === null ? null : (
            <a className="btn btn-ink" href={talkNowHref}>
              <span className="dot l-bg3ddc84" />
              Talk now
            </a>
          )}
          {scheduleHref === null ? null : (
            <a
              className={talkNowHref === null ? "btn btn-ink" : "btn btn-line"}
              href={scheduleHref}
            >
              <CalendarIcon />
              Schedule
            </a>
          )}
          <a className="btn btn-line" href={profileHref}>
            View profile
          </a>
        </div>
      </div>
    </article>
  );
}
