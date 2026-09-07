/** Customer request dates use the service timezone on both server and browser. */
export function formatRequestDate(iso: string): string {
 return new Date(iso).toLocaleDateString('he-IL', {day:'numeric',month:'long',timeZone:'Asia/Jerusalem'});
}
