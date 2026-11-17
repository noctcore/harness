import type { IMetaCtx, IMetaRule, IViolation } from '@noctcore/harness';

export const readmeHasLicense: IMetaRule = {
  id: 'readme-has-license',
  category: 'config',
  ciCritical: true,
  description: 'The README has a License section.',
  run(ctx: IMetaCtx): IViolation[] {
    const readme = ctx.read('README.md');
    if (readme !== null && /^## License$/m.test(readme)) return [];
    return [{ file: 'README.md', rule: 'readme-has-license', message: 'Add a "## License" section.' }];
  },
};
