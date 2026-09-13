/** Recognized disposable development databases. Remote use additionally needs
 * the driver's exact host/port/database declaration; this is no production opt-in. */
export function isDisposableCanonicalDatabase(database:string):boolean {
 return /^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(database)
  || /^tivdoc_release_replay_\d{8}$/u.test(database);
}
