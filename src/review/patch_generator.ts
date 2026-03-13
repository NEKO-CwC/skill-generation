/**
 * Patch generator implementing reviewed diff materialization contract.
 */

import type { PatchGenerator, PatchOutput, ReviewResult } from '../shared/types.js';

export class PatchGeneratorImpl implements PatchGenerator {
  public generate(result: ReviewResult, originalContent: string): string {
    return this.generateReportPatch(result, originalContent);
  }

  public generateSplit(result: ReviewResult, originalContent: string): PatchOutput {
    const reportPatch = this.generateReportPatch(result, originalContent);
    const mergeableDocument = result.proposedDocument ?? null;

    return { reportPatch, mergeableDocument };
  }

  private generateReportPatch(result: ReviewResult, originalContent: string): string {
    const lines = [
      `--- PATCH: ${result.metadata.skillKey} ---`,
      `Patch ID: ${result.metadata.patchId}`,
      `Risk: ${result.riskLevel}`,
      `Source Session: ${result.metadata.sourceSessionId}`,
      `Review Source: ${result.reviewSource}`,
    ];

    if (result.target) {
      lines.push(`Target: ${result.target.kind}:${result.target.key}`);
    }

    if (result.changeSummary) {
      lines.push('', '## Change Summary', result.changeSummary);
    }

    if (result.evidenceSummary) {
      lines.push('', '## Evidence Summary', result.evidenceSummary);
    }

    lines.push('', '## Proposed Changes', result.proposedDiff);
    lines.push('', '## Original Content', originalContent);

    if (result.proposedDocument) {
      lines.push('', '## Proposed Document', result.proposedDocument);
    }

    return lines.join('\n');
  }
}

export default PatchGeneratorImpl;
