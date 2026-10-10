// @vitest-environment jsdom
//
// The first component in this repo tested by MOUNTING it.
//
// Audit 11's structural finding: vitest ran in `node` with a `.test.ts`-only
// glob, so every guard on the order card was pinned by a string match — and
// three of those matched happily while the property they named was false.
// `FormSection`'s own `problem` rule was one of them: the test asserted the
// text `const shown = open || !!problem;` appeared in the file, which it did,
// while `bothLegs` disabled the submit button with its explanation folded out
// of sight.
//
// Everything below asks the DOM instead.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormSection } from "./FormSection";

const BODY = "the controls";

function setup(props: Partial<React.ComponentProps<typeof FormSection>> = {}) {
  const onToggle = vi.fn();
  const view = render(
    <FormSection title="Take profit" summary="None" open={false} onToggle={onToggle} {...props}>
      <p>{BODY}</p>
    </FormSection>,
  );
  return { onToggle, ...view };
}

describe("folding hides controls, never commitments", () => {
  it("hides the body when closed", () => {
    setup();
    expect(screen.queryByText(BODY)).not.toBeInTheDocument();
  });

  it("shows the body when open", () => {
    setup({ open: true });
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it("keeps the summary visible while closed", () => {
    // The whole licence for folding a set take-profit away: the price stays on
    // screen even though the input does not.
    setup({ summary: "$0.132000" });
    expect(screen.queryByText(BODY)).not.toBeInTheDocument();
    expect(screen.getByText("$0.132000")).toBeInTheDocument();
  });
});

describe("a problem forces the body open", () => {
  it("shows the body even when closed", () => {
    // This is the property the old string-matching test CLAIMED to check.
    setup({ problem: true });
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it("stays open after the parent flips `open` back to false", () => {
    // Clicking appears to do nothing, which is the intent — a disabled submit
    // button must not have its reason folded away.
    const { onToggle, rerender } = setup({ problem: true, open: true });
    expect(screen.getByText(BODY)).toBeInTheDocument();
    rerender(
      <FormSection title="Take profit" summary="None" problem open={false} onToggle={onToggle}>
        <p>{BODY}</p>
      </FormSection>,
    );
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it("colours the summary amber so the reason is visible at a glance", () => {
    setup({ summary: "$0.105000", problem: true });
    expect(screen.getByText("$0.105000").className).toMatch(/amber/);
  });

  it("leaves the summary neutral when there is no problem", () => {
    setup({ summary: "$0.105000" });
    expect(screen.getByText("$0.105000").className).not.toMatch(/amber/);
  });
});

describe("the toggle behaves like a control", () => {
  it("reports its state to assistive tech", () => {
    setup();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("reports expanded when a problem forced it open", () => {
    // Not merely "open === false" — what a screen reader is told has to match
    // what is on screen.
    setup({ problem: true });
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("calls onToggle when clicked", async () => {
    const { onToggle } = setup();
    await userEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders a title that is not a plain string", () => {
    // Both call sites pass a fragment carrying the "· optional" suffix.
    render(
      <FormSection title={<>Stop loss <span>· optional</span></>} summary="None"
        open={false} onToggle={() => {}}><p>x</p></FormSection>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Stop loss · optional");
  });
});
