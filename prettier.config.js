/** @type {import('prettier').Config & import('prettier-plugin-tailwindcss').PluginOptions} */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  plugins: ['prettier-plugin-tailwindcss'],
  // Tailwind v4 has no config file: the plugin reads the theme from here, so it
  // knows tokens like text-acid and sorts them with the utilities they belong to.
  tailwindStylesheet: './src/index.css',
  overrides: [
    {
      // The chart keeps Helm's double quotes, as nodex's chart does.
      files: 'helm/**',
      options: { singleQuote: false },
    },
  ],
}
