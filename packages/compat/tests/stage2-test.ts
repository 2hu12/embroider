import 'qunit';
import { Project, BuildResult, installFileAssertions } from '@embroider/test-support';

import { throwOnWarnings } from '@embroider/core';
import Options from '../src/options';

QUnit.module('stage2 build', function() {
  QUnit.module('static with rules', function(origHooks) {
    let { hooks, test } = installFileAssertions(origHooks);
    let build: BuildResult;

    throwOnWarnings(hooks);

    hooks.before(async function(assert) {
      let app = Project.emberNew();
      (app.files.app as Project['files']).templates = {
        'index.hbs': `
          <HelloWorld @useDynamic="first-choice" />
          <HelloWorld @useDynamic={{"second-choice"}} />
          <HelloWorld @useDynamic={{component "third-choice"}} />
        `,
        'curly.hbs': `
          {{hello-world useDynamic="first-choice" }}
          {{hello-world useDynamic=(component "third-choice") }}
        `,
        components: {
          'first-choice.hbs': 'first',
          'second-choice.hbs': 'second',
          'third-choice.hbs': 'third',
        },
      };

      (app.files.app as Project['files']).components = {
        'uses-inline-template.js': `
        import hbs from "htmlbars-inline-precompile";
        export default Component.extend({
          layout: hbs${'`'}{{first-choice}}${'`'}
        })
        `,
      };

      let addon = app.addAddon('my-addon');
      addon.files.addon = {
        components: {
          'hello-world.js': `
            import Component from '@ember/component';
            import layout from '../templates/components/hello-world';
            import computed from '@ember/object/computed';
            import somethingExternal from 'not-a-resolvable-package';
            export default Component.extend({
              dynamicComponentName: computed('useDynamic', function() {
                return this.useDynamic || 'default-dynamic';
              }),
              layout
            });
          `,
          'has-relative-template.js': `
            import Component from '@ember/component';
            import layout from './t';
            export default Component.extend({
              layout
            });
          `,
          't.hbs': ``,
        },
        'synthetic-import-1.js': '',
        templates: {
          components: {
            'hello-world.hbs': `
              {{component dynamicComponentName}}
            `,
          },
        },
      };
      addon.files.app = {
        components: {
          'hello-world.js': `export { default } from 'my-addon/components/hello-world'`,
        },
        templates: {
          components: {
            'direct-template-reexport.js': `export { default } from 'my-addon/templates/components/hello-world';`,
          },
        },
      };

      let options: Options = {
        staticComponents: true,
        staticHelpers: true,
        packageRules: [
          {
            package: 'my-addon',
            components: {
              '{{hello-world}}': {
                acceptsComponentArguments: [
                  {
                    name: 'useDynamic',
                    becomes: 'dynamicComponentName',
                  },
                ],
                layout: {
                  addonPath: 'templates/components/hello-world.hbs',
                },
              },
            },
            addonModules: {
              'components/hello-world.js': {
                dependsOnModules: ['../synthetic-import-1'],
                dependsOnComponents: ['{{second-choice}}'],
              },
            },
            appModules: {
              'components/hello-world.js': {
                dependsOnModules: ['my-addon/synthetic-import-1'],
              },
            },
          },
        ],
      };
      build = await BuildResult.build(app, {
        stage: 2,
        type: 'app',
        emberAppOptions: {
          tests: false,
        },
        embroiderOptions: options,
      });
      assert.basePath = build.outputPath;
    });

    hooks.after(async function() {
      await build.cleanup();
    });

    test('index.hbs', function(assert) {
      let assertFile = assert.file('templates/index.hbs').transform(build.transpile);
      assertFile.matches(/import \w+ from ["']..\/components\/hello-world\.js["']/, 'explicit dependency');
      assertFile.matches(
        /import \w+ from ["'].\/components\/third-choice\.hbs["']/,
        'static component helper dependency'
      );
      assertFile.matches(/import \w+ from ["'].\/components\/first-choice\.hbs["']/, 'rule-driven string attribute');
      assertFile.matches(
        /import \w+ from ["'].\/components\/second-choice\.hbs["']/,
        'rule-driven mustache string literal'
      );
    });

    test('curly.hbs', function(assert) {
      let assertFile = assert.file('templates/curly.hbs').transform(build.transpile);
      assertFile.matches(/import \w+ from ["']..\/components\/hello-world\.js["']/, 'explicit dependency');
      assertFile.matches(
        /import \w+ from ["'].\/components\/third-choice\.hbs["']/,
        'static component helper dependency'
      );
      assertFile.matches(/import \w+ from ["'].\/components\/first-choice\.hbs["']/, 'rule-driven string attribute');
    });

    test('hello-world.hbs', function(assert) {
      // the point of this test is to ensure that we can transpile with no
      // warning about the dynamicComponentName.
      let assertFile = assert
        .file('node_modules/my-addon/templates/components/hello-world.hbs')
        .transform(build.transpile);

      // this is a pretty trivial test, but it's needed to force the
      // transpilation to happen because transform() is lazy.
      assertFile.matches(/dynamicComponentName/);
    });

    test('addon/hello-world.js', function(assert) {
      let assertFile = assert.file('node_modules/my-addon/components/hello-world.js').transform(build.transpile);
      assertFile.matches(/import a. from ["']\.\.\/synthetic-import-1/);
      assertFile.matches(/window\.define\(["']\my-addon\/synthetic-import-1["']/);
      assertFile.matches(/import a. from ["']\.\.\/\.\.\/\.\.\/templates\/components\/second-choice\.hbs["']/);
      assertFile.matches(/window\.define\(["']my-app\/templates\/components\/second-choice["']/);
      assertFile.matches(
        /import somethingExternal from ["'].*\/externals\/not-a-resolvable-package["']/,
        'externals are handled correctly'
      );
    });

    test('app/hello-world.js', function(assert) {
      let assertFile = assert.file('./components/hello-world.js').transform(build.transpile);
      assertFile.matches(/import a. from ["']\.\.\/node_modules\/my-addon\/synthetic-import-1/);
      assertFile.matches(/window\.define\(["']my-addon\/synthetic-import-1["']/);
      assertFile.matches(
        /export \{ default \} from ['"]my-addon\/components\/hello-world['"]/,
        'retains absolute package name import'
      );
    });

    test('app/templates/components/direct-template-reexport.js', function(assert) {
      let assertFile = assert.file('./templates/components/direct-template-reexport.js').transform(build.transpile);
      assertFile.matches(
        /export \{ default \} from ['"]my-addon\/templates\/components\/hello-world.hbs['"]/,
        'rewrites absolute imports of templates to explicit hbs'
      );
    });

    test('uses-inline-template.js', function(assert) {
      let assertFile = assert.file('./components/uses-inline-template.js').transform(build.transpile);
      assertFile.matches(/import a. from ["']\.\.\/templates\/components\/first-choice.hbs/);
      assertFile.matches(/window\.define\(["']\my-app\/templates\/components\/first-choice["']/);
    });

    test('component with relative import of arbitrarily placed template', function(assert) {
      let assertFile = assert
        .file('node_modules/my-addon/components/has-relative-template.js')
        .transform(build.transpile);
      assertFile.matches(/import layout from ["']\.\/t.hbs['"]/, 'arbitrary relative template gets hbs extension');
    });
  });

  QUnit.module('customized tree hooks', function(origHooks) {
    let { hooks, test } = installFileAssertions(origHooks);
    let build: BuildResult;
    throwOnWarnings(hooks);

    hooks.before(async function(assert) {
      let app = Project.emberNew();

      let addon = app.addAddon(
        'my-addon',
        `
        treeForAddon(tree) {
          // doesn't call super, so we're emitting the raw contents of the addon
          // directory
          return tree;
        }
      `
      );
      addon.files.addon = {
        'my-addon': {
          'index.js': `
            // the index
          `,
          'other-module.js': `
            // other module
          `,
        },
        'single-file-lib.js': '// single file lib',
        'multi-file-lib': {
          'index.js': '// multi file lib',
        },
      };
      build = await BuildResult.build(app, {
        stage: 2,
        type: 'app',
        emberAppOptions: { tests: false },
      });
      assert.basePath = build.outputPath;
    });

    hooks.after(async function() {
      await build.cleanup();
    });

    test('emits own addon tree output', function(assert) {
      let assertFile = assert.file('./node_modules/my-addon/index.js');
      assertFile.matches(/the index/, 'our own addon tree output is in the right place');
    });

    test('captures a multi-file module that tried to escape our namespace', function(assert) {
      let assertFile = assert.file('./node_modules/my-addon/multi-file-lib/index.js');
      assertFile.matches(/multi file lib/, 'content of multi-file-lib is captured');

      let pkgJSON = assert.file('./node_modules/my-addon/package.json').json();
      pkgJSON.get('ember-addon.renamed-modules.multi-file-lib').equals('my-addon/multi-file-lib');
    });

    test('captures a single-file module that tried to escape our namespace', function(assert) {
      let assertFile = assert.file('./node_modules/my-addon/single-file-lib/index.js');
      assertFile.matches(/single file lib/, 'content of single-file-lib is captured');

      let pkgJSON = assert.file('./node_modules/my-addon/package.json').json();
      pkgJSON.get('ember-addon.renamed-modules.single-file-lib').equals('my-addon/single-file-lib');
    });
  });
});
