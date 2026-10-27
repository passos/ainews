// #87 A4: admin tables never wrap headers or cells (IDs, numbers, dates, pills
// and buttons stay on one line) and scroll sideways inside their wrapper. Only
// the Name and URL cells may wrap: put ADMIN_WRAP_CELL on a block inside the
// cell (a class on the cell itself loses to the table's cell rule).
// Literal class names: Tailwind finds them by scanning the source.
export const ADMIN_TABLE = "[&_th]:whitespace-nowrap [&_td]:whitespace-nowrap";
export const ADMIN_TABLE_WRAP = "overflow-x-auto rounded-lg border";
export const ADMIN_WRAP_CELL = "whitespace-normal";
export const ADMIN_URL_CELL = "whitespace-normal break-all";
