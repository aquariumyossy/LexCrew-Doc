/* eslint-disable no-undef */

const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const urlDev = "https://localhost:28765/";
const urlProd = "https://localhost:28765/";

module.exports = (_env, options) => {
  const dev = options.mode === "development";
  const config = {
    mode: options.mode || "development",
    devtool: "source-map",
    entry: {
      polyfill: ["core-js/stable", "regenerator-runtime/runtime"],
      react: ["react", "react-dom"],
      taskpane: {
        import: ["./src/taskpane/index.tsx", "./src/taskpane/taskpane.html"],
        dependOn: "react",
      },
      commands: "./src/commands/commands.ts",
    },
    output: {
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".html", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
          },
        },
        {
          test: /\.tsx?$/,
          exclude: /node_modules|\.test\.ts$/,
          use: ["ts-loader"],
        },
        {
          test: /\.html$/,
          exclude: /node_modules/,
          use: "html-loader",
        },
        {
          test: /\.(png|jpg|jpeg|ttf|woff|woff2|gif|ico)$/,
          type: "asset/resource",
          generator: {
            filename: "assets/[name][ext][query]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["polyfill", "taskpane", "react"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "assets/*",
            to: "assets/[name][ext][query]",
          },
          {
            // pdf.js starts a module worker from a URL, so its worker ships as
            // a file rather than a bundle chunk. Named .js so the host serves
            // it as script whatever it makes of .mjs.
            from: "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
            to: "assets/pdf.worker.js",
          },
          {
            // Fetched by URL rather than bundled: the CJK character maps that a
            // Japanese CID-keyed PDF needs to give up its text, the standard
            // fonts, and the JBIG2 and JPEG 2000 decoders a scan from a copier
            // is encoded with. Around 3MB, and an add-in may have no network.
            context: "node_modules/pdfjs-dist",
            from: "{cmaps,standard_fonts,wasm,iccs}/**/*",
            to: "assets/pdf/[path][name][ext]",
          },
          {
            from: "manifest*.xml",
            to: "[name]" + "[ext]",
            transform(content) {
              if (dev) {
                return content;
              }
              return content
                .toString()
                .replace(new RegExp(urlDev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), urlProd);
            },
          },
        ],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["polyfill", "commands"],
      }),
      /*
       * No `ProvidePlugin` for `Promise`. The Office template shims every free
       * `Promise` in the bundle to `es6-promise`, which stopped at ES6: pdf.js
       * calls `Promise.withResolvers` and got "is not a function" while the
       * page's own Promise had it. `core-js/stable` in the polyfill entry
       * patches the real global, which is what a library expects to find.
       */
    ],
  };

  return config;
};
