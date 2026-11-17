import type { IMetaCtx, IMetaRule, IViolation } from '@noctcore/harness';
import { isGrandfathered, loadBaseline } from '@noctcore/harness';

const ID = 'max-file-lines';
const LIMIT = 300;

function sizes(ctx: IMetaCtx): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of ctx.glob('src/**/*.ts')) {
    const lines = (ctx.read(file) ?? '').split('\n').length;
    if (lines > LIMIT) found.set(file, lines);
  }
  return found;
}

export const maxFileLines: IMetaRule = {
  id: ID,
  category: 'source-text',
  ciCritical: true,
  description: `Source files stay at or under ${LIMIT} lines; older offenders are frozen in a baseline.`,
  baseline(ctx: IMetaCtx): Record<string, number> {
    return Object.fromEntries(sizes(ctx));
  },
  run(ctx: IMetaCtx): IViolation[] {
    const frozen = loadBaseline(ctx, ID);
    const violations: IViolation[] = [];
    for (const [file, lines] of sizes(ctx)) {
      if (isGrandfathered(frozen, file, lines)) continue;
      const was = frozen[file];
      violations.push({
        file,
        rule: ID,
        message:
          was === undefined
            ? `${lines} lines, over the limit of ${LIMIT}.`
            : `${lines} lines, grown past its frozen ${was}. Shrink it back.`,
      });
    }
    return violations;
  },
};
