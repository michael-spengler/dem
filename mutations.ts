import {
  Action,
  ADD_ALIAS,
  ADD_LINK,
  ADD_MODULE,
  REMOVE_ALIAS,
  REMOVE_LINK,
  REMOVE_MODULE,
  UPDATE_MODULE,
} from "./actions.ts";
import { duplicateStore, Store } from "./store.ts";
import { compareModules, Module, moduleEquals } from "./module.ts";
import { Repository } from "./repository.ts";
import { createURL } from "./net.ts";
import * as path from "./vendor/https/deno.land/std/path/mod.ts";
import { hasDefaultExportLocal, hasDefaultExportRemote } from "./ast.ts";

const vendorDirectoryPath = "vendor";

// mutateStore mutates store. This affects only for memory.
export function mutateStore(store: Store, actions: Action[]): Store {
  const s = duplicateStore(store);
  const { modules } = s.config;
  const aliases = { ...s.config.aliases };
  for (const action of actions) {
    switch (action.type) {
      case ADD_MODULE: {
        const { module } = action.payload;
        for (const mod of modules) {
          if (moduleEquals(mod, module)) {
            throw new Error(`module already exists: ${module.toString()}
to update module, please use 'dem update'.`);
          }
        }
        modules.push(module);
        break;
      }

      case REMOVE_MODULE: {
        const { moduleProtocol, modulePath } = action.payload;
        const urlStr = `${moduleProtocol}://${modulePath}`;
        let foundModIndex = 0;
        let foundMod: Module | undefined;
        for (const mod of modules) {
          if (urlStr.startsWith(mod.toString())) {
            foundMod = mod;
            break;
          }
          foundModIndex++;
        }
        if (!foundMod) {
          throw new Error(`remove module: module not found for: ${urlStr}`);
        }
        modules.splice(foundModIndex, 1);
        break;
      }

      case ADD_LINK: {
        const { link } = action.payload;
        const foundMod = modules.find((mod) => {
          return link.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(`add link: module not found for: ${link}`);
        }
        const filePath = link.split(foundMod.toString())[1];
        if (foundMod.files.includes(filePath)) {
          break;
        }
        foundMod.files.push(filePath);
        break;
      }

      case REMOVE_LINK: {
        const { link } = action.payload;
        const foundMod = modules.find((mod) => {
          return link.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(`remove link: module not found for: ${link}`);
        }
        const filePath = link.split(foundMod.toString())[1];
        const foundFileIndex = foundMod.files.indexOf(filePath);
        if (foundFileIndex < 0) {
          throw new Error(`file not linked: ${link}`);
        }
        foundMod.files.splice(foundFileIndex, 1);
        break;
      }

      case ADD_ALIAS: {
        const { aliasPath, aliasTargetPath } = action.payload;

        if (aliases[aliasPath]) {
          throw new Error(
            `alias already exists for: ${aliasPath}. please execute dem unalias before this.`,
          );
        }

        const foundMod = modules.find((mod) => {
          return aliasTargetPath.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(
            `add alias: module not found for: ${aliasTargetPath}`,
          );
        }

        aliases[aliasPath] = aliasTargetPath;
        break;
      }

      case REMOVE_ALIAS: {
        const { aliasPath } = action.payload;
        if (!aliases[aliasPath]) {
          throw new Error(`alias does not exist for: ${aliasPath}.`);
        }
        delete aliases[aliasPath];
        break;
      }

      case UPDATE_MODULE: {
        const { moduleProtocol, modulePath, moduleVersion } = action.payload;
        const urlStr = `${moduleProtocol}://${modulePath}`;
        const foundMod = modules.find((mod) => {
          return mod.protocol === moduleProtocol && mod.path === modulePath;
        });
        if (!foundMod) {
          throw new Error(`update module: module not found for: ${urlStr}`);
        }
        foundMod.version = moduleVersion;
        break;
      }
    }
  }

  // sort modules
  modules.sort(compareModules);
  for (const mod of modules) {
    mod.files.sort();
  }

  // sort aliases
  const aliasesEntries = Object.entries(aliases);
  aliasesEntries.sort((a, b) => {
    return a[0].localeCompare(b[0]);
  });
  s.config.aliases = Object.fromEntries(aliasesEntries);

  return s;
}

// mutateRepository mutates files controlled by repository.
// This persists mutated files.
export async function mutateRepository(
  repository: Repository,
  store: Store,
  actions: Action[],
) {
  const { modules } = store.config;
  for (const action of actions) {
    switch (action.type) {
      case ADD_MODULE: {
        // Do nothing for add module.
        break;
      }

      case REMOVE_MODULE: {
        const { moduleProtocol, modulePath } = action.payload;
        await repository.removeModule(moduleProtocol, modulePath);
        break;
      }

      case ADD_LINK: {
        const { link } = action.payload;
        // find module
        const foundMod = modules.find((mod) => {
          return link.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(`add link: module not found for: ${link}`);
        }

        const filePath = link.split(foundMod.toString())[1];
        const url = createURL(
          foundMod.protocol,
          foundMod.path,
          foundMod.version,
          filePath,
        );
        const hasDefault = await hasDefaultExportRemote(url);

        await repository.addLink(
          foundMod.protocol,
          foundMod.path,
          foundMod.version,
          filePath,
          hasDefault,
        );
        break;
      }

      case REMOVE_LINK: {
        const { link } = action.payload;
        const foundMod = modules.find((mod) => {
          return link.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(`remove link: module not found for: ${link}`);
        }

        // create file path
        const filePath = link.split(foundMod.toString())[1];
        await repository.removeLink(foundMod.protocol, foundMod.path, filePath);
        break;
      }

      case ADD_ALIAS: {
        const { aliasPath, aliasTargetPath } = action.payload;

        const foundMod = modules.find((mod) => {
          return aliasTargetPath.startsWith(mod.toString());
        });
        if (!foundMod) {
          throw new Error(
            `add alias: module not found for: ${aliasTargetPath}`,
          );
        }

        const linkedFilePath = aliasTargetPath.split(foundMod.toString())[1];

        const fp = path.join(
          vendorDirectoryPath,
          foundMod.protocol,
          foundMod.path,
          linkedFilePath,
        );

        let hasDefault = false;
        try {
          hasDefault = await hasDefaultExportLocal(fp);
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
          }
          // let has default as false
        }

        await repository.addAlias(
          foundMod.protocol,
          foundMod.path,
          linkedFilePath,
          aliasPath,
          hasDefault,
        );
        break;
      }

      case REMOVE_ALIAS: {
        const { aliasPath } = action.payload;
        await repository.removeAlias(aliasPath);
        break;
      }

      case UPDATE_MODULE: {
        const { moduleProtocol, modulePath, moduleVersion } = action.payload;
        const urlStr = `${moduleProtocol}://${modulePath}`;
        const foundMod = modules.find((mod) => {
          return mod.protocol === moduleProtocol && mod.path === modulePath;
        });
        if (!foundMod) {
          throw new Error(`update module: module not found for: ${urlStr}`);
        }

        for (const filePath of foundMod.files) {
          const url = createURL(
            moduleProtocol,
            modulePath,
            moduleVersion,
            filePath,
          );
          const hasDefault = await hasDefaultExportRemote(url);

          await repository.updateLink(
            moduleProtocol,
            modulePath,
            moduleVersion,
            filePath,
            hasDefault,
          );
        }
        break;
      }
    }
  }
}
