"use client";

// The home page finder of the owner's UI/UX design (hero search): the
// visitor describes the matter in a few words, picks a legal issue (a
// keyword match over the published practice areas may suggest one; the
// visitor decides) and, when more than one is listed, the state connected to
// the matter. It submits an ordinary GET form to the public directory, so it
// works without scripts; nothing is stored and nothing is sent elsewhere.

import { useId, useMemo, useState } from "react";

type Option = { readonly id: string; readonly name: string };

type HomeFinderProps = {
  readonly practiceAreas: readonly Option[];
  readonly jurisdictions: readonly Option[];
};

type Panel = "suggest" | "issues" | "location" | null;

// Words of two letters or more, lower-cased, without punctuation.
function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

// The practice area whose name shares the most words (or word stems of at
// least four letters) with the visitor's words; null when none shares any.
export function suggestedArea(
  text: string,
  areas: readonly Option[],
): Option | null {
  const words = wordsOf(text);
  let best: Option | null = null;
  let bestScore = 0;
  for (const area of areas) {
    const names = wordsOf(area.name);
    let score = 0;
    for (const word of words) {
      for (const name of names) {
        const stem = Math.min(word.length, name.length, 5);
        if (
          word === name ||
          (stem >= 4 && word.slice(0, stem) === name.slice(0, stem))
        ) {
          score += 1;
        }
      }
    }
    if (score > bestScore) {
      best = area;
      bestScore = score;
    }
  }
  return best;
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function GridIcon({ size }: { readonly size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z" />
    </svg>
  );
}

export function HomeFinder({ practiceAreas, jurisdictions }: HomeFinderProps) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [issue, setIssue] = useState<Option | null>(null);
  const [place, setPlace] = useState<Option | null>(
    jurisdictions.length === 1 ? jurisdictions[0] : null,
  );
  const [panel, setPanel] = useState<Panel>(null);
  const suggestion = useMemo(
    () => (text.trim() === "" ? null : suggestedArea(text, practiceAreas)),
    [text, practiceAreas],
  );
  const others = practiceAreas.filter((area) => area.id !== suggestion?.id);
  const ready = issue !== null && place !== null;

  function chooseIssue(option: Option) {
    setIssue(option);
    setPanel(place === null && jurisdictions.length > 0 ? "location" : null);
  }

  function choosePlace(option: Option) {
    setPlace(option);
    setPanel(null);
  }

  return (
    <form
      className="finder l-mt40"
      role="search"
      aria-label="Find an attorney"
      action="/find-an-attorney"
      method="get"
      onSubmit={(event) => {
        if (!ready) {
          event.preventDefault();
          setPanel(
            issue === null
              ? text.trim() !== "" && practiceAreas.length > 0
                ? "suggest"
                : "issues"
              : "location",
          );
        }
      }}
    >
      {place === null ? null : (
        <input type="hidden" name="jurisdiction" value={place.id} />
      )}
      {issue === null ? null : (
        <input type="hidden" name="practice_area" value={issue.id} />
      )}
      <div className="lbl">
        <label htmlFor={inputId}>What do you need help with?</label>
        <span>A few words is enough</span>
      </div>
      <div className="l-posrelative">
        <div className="ffield">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            id={inputId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="e.g. landlord kept my security deposit"
            autoComplete="off"
            maxLength={200}
          />
          {text === "" ? null : (
            <button
              className="clr"
              type="button"
              onClick={() => setText("")}
              aria-label="Clear"
            >
              <CloseIcon />
            </button>
          )}
          <button className="btn btn-ink" type="submit">
            <span>{ready ? "Find attorneys" : "Continue"}</span>
          </button>
        </div>
        {panel === "suggest" ? (
          <div
            className="sheet"
            role="dialog"
            aria-label="Suggested legal issue"
          >
            <div className="hd">
              Step 1 of 2 · Legal issue
              <span className="steps" aria-hidden="true">
                <i className="on" />
                <i />
              </span>
              <button
                className="xbtn"
                type="button"
                onClick={() => setPanel(null)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="l-p8-8-4">
              {suggestion === null ? null : (
                <div className="row l-g12-p10-10-10-12-r11-bgpaper">
                  <span className="stack l-f1-minw0-g1">
                    <span className="row sm l-g8-fw600">
                      {suggestion.name}
                      <span className="xs subtle l-fw500">May be relevant</span>
                    </span>
                  </span>
                  <button
                    className="btn btn-ink btn-sm"
                    type="button"
                    onClick={() => chooseIssue(suggestion)}
                  >
                    Use
                  </button>
                </div>
              )}
              <p className="xs subtle l-p12-4-8-fw500">
                {suggestion === null
                  ? "Choose the legal issue that fits"
                  : "Or choose another legal issue"}
              </p>
              <div className="row l-g6-fwrwrap-p0-2-6">
                {others.map((area) => (
                  <button
                    className="opt-chip"
                    type="button"
                    key={area.id}
                    onClick={() => chooseIssue(area)}
                  >
                    {area.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="ft">
              <span className="xs subtle">
                Based on your words only — you decide what fits.
              </span>
              <a className="link xs l-fs13" href="/client/requests/new">
                <CompassIcon />
                Help me find an attorney
              </a>
            </div>
          </div>
        ) : null}
        {panel === "issues" ? (
          <div
            className="sheet"
            role="dialog"
            aria-label="Choose a legal issue"
          >
            <div className="hd">
              Choose a legal issue
              <button
                className="xbtn l-mlauto"
                type="button"
                onClick={() => setPanel(null)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
            {practiceAreas.length === 0 ? (
              <p className="sm muted l-p10-16-14">
                No legal issues are listed yet.
              </p>
            ) : (
              <div className="l-dgrid-cols1fr-1fr-g2-p6-6-8">
                {practiceAreas.map((area) => (
                  <button
                    className={issue?.id === area.id ? "opt on" : "opt"}
                    type="button"
                    key={area.id}
                    onClick={() => chooseIssue(area)}
                  >
                    <span className="stack l-g1">
                      <span className="sm l-fw600-cink">{area.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="ft">
              <span className="xs subtle">Not sure which one fits?</span>
              <a className="link xs l-fs13" href="/client/requests/new">
                <CompassIcon />
                Help me find an attorney
              </a>
            </div>
          </div>
        ) : null}
        {panel === "location" ? (
          <div
            className="sheet"
            role="dialog"
            aria-label="Which state is connected to your legal matter"
          >
            <div className="hd">
              Step 2 of 2 · Location
              <span className="steps" aria-hidden="true">
                <i className="on" />
                <i className="on" />
              </span>
              <button
                className="xbtn"
                type="button"
                onClick={() => setPanel(null)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="l-p10-16-14">
              <p className="h4 l-fs17">
                Which state is connected to your legal matter?
              </p>
              <p className="sm muted l-mt2">
                This can be different from where you live.
              </p>
              {jurisdictions.length === 0 ? (
                <p className="sm muted l-mt10">No states are listed yet.</p>
              ) : (
                <div className="row l-g6-mt12-fwrwrap">
                  {jurisdictions.map((option) => (
                    <button
                      className="opt-chip"
                      type="button"
                      key={option.id}
                      onClick={() => choosePlace(option)}
                    >
                      {option.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="ft l-jcflex-start-aiflex-start-g10">
              <span className="xs subtle">
                Used to show attorneys who may be relevant. It doesn’t decide
                which state’s law applies — you choose your attorney.
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="fopts">
        {issue === null ? (
          <button
            className="fopt"
            type="button"
            onClick={() => setPanel(panel === "issues" ? null : "issues")}
            aria-expanded={panel === "issues"}
          >
            <GridIcon size={15} />
            Choose a legal issue
          </button>
        ) : (
          <span className="tok l-ml8">
            <GridIcon size={14} />
            {issue.name}
            <button
              className="x"
              type="button"
              onClick={() => setIssue(null)}
              aria-label="Remove legal issue"
            >
              <CloseIcon />
            </button>
          </span>
        )}
        {place === null || jurisdictions.length < 2 ? null : (
          <span className="tok l-ml4">
            {place.name}
            <button
              className="x"
              type="button"
              onClick={() => setPlace(null)}
              aria-label="Remove location"
            >
              <CloseIcon />
            </button>
          </span>
        )}
        <span className="fsep" aria-hidden="true" />
        <a className="fopt" href="/client/requests/new">
          <CompassIcon />
          Help me find an attorney
        </a>
        <span className="fsep" aria-hidden="true" />
        <a className="fopt" href="/find-an-attorney">
          Browse all attorneys
        </a>
      </div>
    </form>
  );
}
