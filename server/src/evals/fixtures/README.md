# Vision eval fixtures

Images attached to `answerQualityCases.js` cases that exercise the Vision Ask path
(`askQuestionUsingDocuments({ image })`). Loaded through
[`../visionFixtures.js`](../visionFixtures.js), which validates each file and refuses a
degenerate one.

## The rule these files follow

**A fixture must not contain anything readable as a repair specification.** No text, no
digits, no torque or capacity figures. The image is context for the question; repair facts
must still come from cited PDF chunks. That is the property the vision cases test, and a
picture with a number in it would make a passing run ambiguous.

## `dashboard-cluster.png`

288x216 RGB PNG, ~21 KB. A synthetic instrument cluster: two bezelled gauges with tick
marks and needles, an amber warning triangle, on a dark panel with a vignette and a hood
shadow. Drawn programmatically — no photograph of a real vehicle, and **no glyph in it is a
character or a digit**, which is checkable by looking at it.

It replaces a 1x1 placeholder PNG that made `vision-refuses-unsupported-spec` fail every
live run with a provider HTTP 400 before the behavior under test could run
(see [`../../../../docs/evals/ask-rag-iteration-log.md`](../../../../docs/evals/ask-rag-iteration-log.md)).

Substituting a real photograph later is fine and needs no code change, as long as it obeys
the rule above and stays PNG.
