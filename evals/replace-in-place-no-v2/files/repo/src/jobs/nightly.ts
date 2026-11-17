import { saveTask } from '../api/saveTask.js';
export function nightlyImport(rows: string[]) { return rows.map(title => saveTask({ title })); }
