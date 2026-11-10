import { describe, expect, it } from "vitest";
import {
  getWorkflowTemplate,
  workflowCatalogToMarkdown,
  workflowRunDraftMarkdown,
  workflowTemplateToMarkdown,
  workflowTemplatesForDomain
} from "../src/workflows";

describe("workflows", () => {
  it("defines safe trading review workflow", () => {
    const workflow = getWorkflowTemplate("trading_review");

    expect(workflow?.agentIds).toContain("trading");
    expect(workflow?.privacyNotes.join("\n")).toContain("永远不喊单");
  });

  it("renders templates to markdown", () => {
    const workflow = getWorkflowTemplate("nightly_consolidation");
    expect(workflow).toBeDefined();

    const markdown = workflowTemplateToMarkdown(workflow!);
    expect(markdown).toContain("夜间轻量整合");
    expect(markdown).toContain("requires user confirmation");
  });

  it("filters templates by domain", () => {
    expect(workflowTemplatesForDomain("knowledge").map((workflow) => workflow.id)).toContain("nightly_consolidation");
  });

  it("renders catalog and run drafts", () => {
    const workflow = getWorkflowTemplate("weekly_review");
    expect(workflow).toBeDefined();

    expect(workflowCatalogToMarkdown()).toContain("LifeOps Workflow Templates");
    expect(workflowRunDraftMarkdown(workflow!, "2026-06-11T00:00:00.000Z")).toContain("步骤清单");
  });
});
