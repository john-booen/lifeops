import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
const baseRule = (selector: string) => css.nodes.find(node => node.type === "rule" && node.selector === selector) as Rule | undefined;
const values = (rule: Rule | undefined) => Object.fromEntries((rule?.nodes ?? []).filter(node => node.type === "decl").map(node => [node.prop, node.value]));
const standbySelector = ".lifeops-neural-chat .lifeops-agent-record.is-active::after";
const activeSelector = ".lifeops-neural-chat:is(.is-thinking, .is-speaking) .lifeops-agent-record.is-active::after";
const hiddenSelector = ".lifeops-steward-conversation[hidden] .lifeops-neural-chat .lifeops-agent-record.is-active::after";

describe("voice reply indicator rendering cost and behavior", () => {
  it("animates only composite properties instead of repainting the button shadow", () => {
    const frames = css.nodes.find(node => node.type === "atrule" && node.name === "keyframes" && node.params === "lifeops-agent-pulse") as AtRule;
    expect(frames).toBeTruthy(); const properties: string[] = [];
    frames.walkDecls(declaration => { properties.push(declaration.prop); });
    expect(new Set(properties)).toEqual(new Set(["opacity", "transform"]));
    expect(values(baseRule(".lifeops-agent-record.is-active"))).not.toHaveProperty("animation");
  });

  it("keeps enabled and listening standby static, animating only busy or speaking", () => {
    const button = values(baseRule(".lifeops-agent-record.is-active"));
    expect(button.color).toBe("var(--lifeops-red)"); expect(button["border-color"]).toBe("var(--lifeops-red)");
    expect(button["box-shadow"]).toBeTruthy();
    const glow = values(baseRule(".lifeops-agent-record.is-active::after"));
    expect(glow.position).toBe("absolute"); expect(glow.inset).toBe("0"); expect(glow["pointer-events"]).toBe("none");
    expect(glow["box-shadow"]).toBeTruthy(); expect(glow["will-change"]).toBe("opacity, transform");
    expect(glow.animation).toContain("lifeops-agent-pulse"); expect(glow).not.toHaveProperty("display", "none");
    expect(values(baseRule(standbySelector))).toMatchObject({ animation: "none", opacity: "0.25", transform: "none", "will-change": "auto" });
    const active = baseRule(activeSelector); expect(active).toBeTruthy();
    // Recording/listening is deliberately absent: it is true for the entire standby session.
    expect(active!.selector.match(/:is\(([^)]+)\)/)?.[1].split(/,\s*/)).toEqual([".is-thinking", ".is-speaking"]);
    expect(values(active).animation).toContain("lifeops-agent-pulse"); expect(values(active)["will-change"]).toBe("opacity, transform");
  });

  it("lets hidden navigation and reduced motion override active feedback", () => {
    const active = baseRule(activeSelector)!, hidden = baseRule(hiddenSelector)!;
    expect(values(hidden)).toMatchObject({ animation: "none", "will-change": "auto" });
    expect(css.nodes.indexOf(hidden)).toBeGreaterThan(css.nodes.indexOf(active));
    // Hidden has the additional wrapper class/attribute; reduced uses the same active specificity later.
    const media = css.nodes.find(node => node.type === "atrule" && node.name === "media" && node.params === "(prefers-reduced-motion: reduce)"
      && node.nodes?.some(child => child.type === "rule" && child.selector === activeSelector)) as AtRule;
    expect(media).toBeTruthy(); const rule = media.nodes?.find(node => node.type === "rule" && node.selector === activeSelector) as Rule;
    expect(values(rule)).toMatchObject({ animation: "none", "will-change": "auto" });
    expect(css.nodes.indexOf(media)).toBeGreaterThan(css.nodes.indexOf(active));
    expect(Number(values(baseRule(standbySelector)).opacity)).toBeGreaterThan(0);
  });

});
