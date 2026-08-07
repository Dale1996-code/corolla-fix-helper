// The AI disclosure and general repair-safety warning shown by both AI features.
//
// These two notices started life as literals inside SearchPage's "Ask your
// documents" card and existed nowhere else, so the Repair Planner -- which sends
// more to OpenAI than Ask does, across a multi-turn agent loop -- shipped with no
// disclosure and no safety warning at all. Hoisting the copy here is what stops a
// second, subtly different wording from appearing on the planner later.
//
// Ask AI is the source of truth: the markup below reproduces its original two
// paragraphs class for class, so adopting this component changed nothing about
// what the Ask page renders.

// Identical on every page. Never fork this string -- a second copy is how the
// two features start telling the owner different things about the same risk.
export const AI_SAFETY_WARNING =
  "Verify torque specs and safety steps against the manual before doing repair work.";

export const AI_DISCLOSURE_ASK =
  "Your question and relevant excerpts from your uploaded PDFs are sent to OpenAI to generate an answer. Photos you attach are also included.";

// Same disclosure, adjusted for what the planner actually sends: it has no
// question and no photo attachment, it has a repair brief, and the excerpts are
// pulled by the agent's own document searches.
export const AI_DISCLOSURE_PLANNER =
  "Your repair brief and relevant excerpts from your uploaded PDFs are sent to OpenAI to build this plan.";

// Planner-only second line. A plan reads like an instruction set in a way a
// single answer does not, so the page has to say plainly that following it is
// still the owner's call -- and where the line is that they should stop.
export const AI_PLANNER_LIMITS =
  "This plan is AI-assisted: it can be incomplete, wrong, or unsupported by your documents, so check every step against the manual or another reliable source before acting on it. Vehicle repair can cause serious injury. Stop and get qualified help if you do not have the right tools, the knowledge, or a safe place to work.";

/**
 * The safety warning and AI disclosure, in that order.
 *
 * Rendered as plain paragraphs with no ARIA role, matching how Ask AI has always
 * shown them: this is standing page text the owner reads before acting, not an
 * event. Giving it `role="alert"`/`role="status"` would make screen readers
 * re-announce it on unrelated re-renders. It stays reachable the way any body
 * copy is -- visible text, in reading order, ahead of the controls it warns
 * about -- rather than through colour or an icon alone.
 *
 * `extraWarning` goes inside the amber paragraph as a block-level span, not a
 * nested `<p>`: the shared sentence has to remain its own text node, and a `<p>`
 * inside a `<p>` is invalid and gets reparented by the browser.
 */
export function AiSafetyNotices({ disclosure, extraWarning = "", className = "" }) {
  return (
    <div className={`space-y-4 ${className}`.trim()}>
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
        {AI_SAFETY_WARNING}
        {extraWarning ? (
          <span className="mt-2 block font-normal leading-6">{extraWarning}</span>
        ) : null}
      </p>

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        {disclosure}
      </p>
    </div>
  );
}
