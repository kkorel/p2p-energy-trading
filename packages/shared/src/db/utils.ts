/**
 * Database Utility Functions
 */

/**
 * Convert a sql.js result row (columns + values array) to an object
 * Note: Returns any for practical use with dynamic SQL results
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToObject(columns: string[], values: any[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = {};
  columns.forEach((col, i) => {
    obj[col] = values[i];
  });
  return obj;
}
