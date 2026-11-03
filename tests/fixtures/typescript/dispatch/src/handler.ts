export interface Handler {
  verify(payload: string): boolean;
}
