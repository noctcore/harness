import type { IMetaRule } from '@noctcore/harness';
import {
  createGithubActionsSecretNoInstallRule,
  createGithubActionsSecurityNoCancelRule,
} from '@noctcore/harness/rules';

import { maxFileLines } from './rules/max-file-lines.mts';
import { readmeHasLicense } from './rules/readme-has-license.mts';

export const META_RULES: IMetaRule[] = [
  createGithubActionsSecretNoInstallRule(),
  createGithubActionsSecurityNoCancelRule(),
  readmeHasLicense,
  maxFileLines,
];
