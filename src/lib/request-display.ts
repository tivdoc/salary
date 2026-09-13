/** Customer request dates use the service timezone on both server and browser. */
export function formatRequestDate(iso: string): string {
 return new Date(iso).toLocaleDateString('he-IL', {day:'numeric',month:'long',timeZone:'Asia/Jerusalem'});
}

/** Month precision stays month precision in the customer statement scope. */
export function formatRequestMonth(month: string): string {
 if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('REQUEST_MONTH_INVALID');
 return new Date(`${month}-01T12:00:00Z`).toLocaleDateString('he-IL',{month:'long',year:'numeric',timeZone:'UTC'});
}
