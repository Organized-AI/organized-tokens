// Declarations for the vendored ./validate.js (see header of validate.js).
export class ProfileError extends Error {
  constructor(error: string, status?: number, code?: string);
  error: string;
  status: number;
  code: string;
}
export function assertNoSecrets(serializedPayload: string): void;
export function assertNoLocalEvidenceLeaks(serializedPayload: string): void;
export function sanitizeProfile(profile: any): any;
export function validateProfileV9(profile: any): void;
export function validateRawProfileV9(profile: any): void;
