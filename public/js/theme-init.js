// Runs before CSS loads to apply the user's saved theme and avoid a flash of
// wrong theme on pages like login and setup. Kept as a standalone file so we
// can drop 'unsafe-inline' from the script CSP.
document.documentElement.setAttribute("data-theme", localStorage.getItem("charon-theme") || "dark");
