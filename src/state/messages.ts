/** Converts domain results (validation issues, import/verify problems, write failures) into i18n Msgs. */
import type { ValidationIssue } from '../core/annotations';
import type { ImportError, VerifyProblem } from '../core/formats/types';
import type { WriteFailureReason } from '../fs';
import { isMessageKey } from '../i18n';
import type { IssueView, Msg, Params } from './contract';

export function msg(key: string, params?: Params): Msg {
  return params ? { key, params } : { key };
}

function cleanParams(params: Readonly<Record<string, string | number>>): Params {
  return { ...params };
}

export function issueView(issue: ValidationIssue): IssueView {
  const params = cleanParams(issue.params);
  if (issue.code === 'overlap' && typeof issue.params.to === 'number') params.last = issue.params.to - 1;
  return { code: issue.code, segmentIds: issue.segmentIds, msg: msg(`ctl.issue.${issue.code}`, params) };
}

export function parseErrorMsg(e: ImportError): Msg {
  const key = `ctl.parse.${e.code}`;
  return msg(isMessageKey(key) ? key : 'import.err.parse', cleanParams(e.params));
}

export function verifyProblemMsg(p: VerifyProblem): Msg {
  const key = `ctl.verify.${p.code}`;
  return msg(isMessageKey(key) ? key : 'import.err.parse', cleanParams(p.params));
}

/** Problems that mean "this file describes another video" rather than "this file is broken". */
export function isIdentityProblem(p: VerifyProblem): boolean {
  return p.code === 'sha256_mismatch' || p.code === 'frame_count_mismatch' || p.code === 'duration_mismatch';
}

export function writeFailureMsg(reason: WriteFailureReason, message: string): Msg {
  return reason === 'unknown' ? msg('ctl.export.failed.unknown', { message }) : msg(`ctl.export.failed.${reason}`);
}

export function indexWarningMsg(code: string): Msg {
  const key = `ctl.indexWarning.${code}`;
  return isMessageKey(key) ? msg(key) : msg('ctl.indexWarning.other', { code });
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return 'unknown';
}
