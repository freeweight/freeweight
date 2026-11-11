import { describe, expect, it } from "vitest";
import { steps, thoughtFor } from "../src/lib/steps";

describe("reasoning steps", () => {
  it("makes one step of each sentence", () => {
    expect(steps("The user wants a price. I should call the tool! Is the address valid? Then answer.")).toEqual([
      "The user wants a price.",
      "I should call the tool!",
      "Is the address valid?",
      "Then answer.",
    ]);
  });

  it("makes one step of each line and each list item, without the marks", () => {
    expect(steps("Plan:\n\n1. Read the **pool** state\n2) Check `owner()`\n- compare both\n\n## Then answer")).toEqual([
      "Plan:",
      "Read the pool state",
      "Check owner()",
      "compare both",
      "Then answer",
    ]);
  });

  it("does not cut at a decimal, a version, a short form or an initial", () => {
    expect(steps("Selling 0.3 WETH lost 0.7%. Uniswap v4.1 is used, e.g. Through a hook. See fig. 2 by J. Smith.")).toEqual([
      "Selling 0.3 WETH lost 0.7%.",
      "Uniswap v4.1 is used, e.g. Through a hook.",
      "See fig. 2 by J. Smith.",
    ]);
    expect(steps("the file is main.rs. it has no tests. Done here now.")).toEqual(["the file is main.rs. it has no tests.", "Done here now."]);
  });

  it("joins a word or two to the sentence after it", () => {
    expect(steps("Okay. Hmm. The question is short, so the answer should be too.")).toEqual(["Okay. Hmm. The question is short, so the answer should be too."]);
    expect(steps("First the price.\nOkay.")).toEqual(["First the price.", "Okay."]);
  });

  it("keeps closing marks with their sentence and reads an ellipsis as one end", () => {
    expect(steps('It says "stop." Then nothing came... Maybe more (see below). End of it.')).toEqual(['It says "stop."', "Then nothing came...", "Maybe more (see below).", "End of it."]);
  });

  it("cuts sentences that end without a space after them", () => {
    expect(steps("先看价格。然后回答问题！")).toEqual(["先看价格。", "然后回答问题！"]);
  });

  it("leaves out lines with no words and counts a code block once", () => {
    expect(steps("Try this:\n```python\ndef f():\n    return 1\n```\n---\n...\nThat works well.")).toEqual(["Try this:", "def f():", "That works well."]);
  });

  it("only ever grows its last step while the text arrives", () => {
    const full = "The question is short, so the answer should be too. I will say what this session is and what it costs, then stop.\n\nOne more check: 1.5 minutes left.";
    let before: string[] = [];
    for (let n = 1; n <= full.length; n++) {
      const now = steps(full.slice(0, n));
      // Everything but the last step that was showing is still there, unchanged.
      expect(now.slice(0, Math.max(0, before.length - 1))).toEqual(before.slice(0, -1));
      expect(now.length).toBeGreaterThanOrEqual(before.length);
      before = now;
    }
    expect(before).toHaveLength(3);
  });

  it("has nothing to show for nothing", () => {
    expect(steps("")).toEqual([]);
    expect(steps(" \n\n ")).toEqual([]);
  });
});

describe("how long a thought took", () => {
  it("prints whole seconds, then minutes", () => {
    expect(thoughtFor(120)).toBe("1 s");
    expect(thoughtFor(7_400)).toBe("7 s");
    expect(thoughtFor(59_600)).toBe("1 min 0 s");
    expect(thoughtFor(72_000)).toBe("1 min 12 s");
  });
});
