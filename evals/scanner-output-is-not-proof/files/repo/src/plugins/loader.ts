export async function load(id: string) { return import(`./${id}.js`); }
