'use strict';

const ensureString = require('type/string/ensure');
const isPlainFunction = require('type/plain-function/is');
const path = require('path');
const fs = require('fs').promises;
const yaml = require('js-yaml');
const cloudformationSchema = require('@serverless/utils/cloudformation-schema');
const ServerlessError = require('../../../serverless-error');

const readFile = async (filePath, servicePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ServerlessError(
      `Cannot parse "${filePath.slice(servicePath.length + 1)}": ${error.message}`,
      'FILE_NOT_ACCESSIBLE'
    );
  }
};

module.exports = {
  resolve: async ({ servicePath, params, address, resolveConfigurationProperty, options }) => {
    if (!params || !params[0]) {
      throw new ServerlessError(
        'Missing path argument in variable "file" source',
        'MISSING_FILE_SOURCE_PATH'
      );
    }
    const filePath = path.resolve(
      servicePath,
      ensureString(params[0], {
        Error: ServerlessError,
        errorMessage: 'Non-string path argument in variable "file" source: %v',
      })
    );
    if (!filePath.startsWith(`${servicePath}${path.sep}`)) {
      throw new ServerlessError(
        'Cannot load file from outside of service folder',
        'FILE_SOURCE_PATH_OUTSIDE_OF_SERVICE'
      );
    }
    if (address != null) {
      address = ensureString(address, {
        Error: ServerlessError,
        errorMessage: 'Non-string address argument for variable "file" source: %v',
      });
    }

    let isResolvedByFunction = false;

    const content = await (async () => {
      switch (path.extname(filePath)) {
        case '.yml':
        case '.yaml': {
          const yamlContent = await readFile(filePath);
          if (yamlContent == null) return null;
          try {
            return yaml.load(yamlContent, {
              filename: filePath,
              schema: cloudformationSchema,
            });
          } catch (error) {
            throw new ServerlessError(
              `Cannot parse "${filePath.slice(servicePath.length + 1)}": ${error.message}`,
              'FILE_PARSE_ERROR'
            );
          }
        }
        case '.tfstate':
        // fallthrough
        case '.json': {
          const jsonContent = await readFile(filePath);
          if (jsonContent == null) return null;
          try {
            return JSON.parse(jsonContent);
          } catch (error) {
            throw new ServerlessError(
              `Cannot parse "${filePath.slice(servicePath.length + 1)}": JSON parse error: ${
                error.message
              }`,
              'FILE_PARSE_ERROR'
            );
          }
        }
        case '.js': {
          try {
            require.resolve(filePath);
          } catch (error) {
            return null;
          }
          let result;
          try {
            result = require(filePath);
          } catch (error) {
            throw new ServerlessError(
              `Cannot load "${filePath.slice(servicePath.length + 1)}": Initialization error: ${
                error && error.stack ? error.stack : error
              }`,
              'FILE_CONTENT_RESOLUTION_ERROR'
            );
          }
          if (isPlainFunction(result)) {
            if (!(await resolveConfigurationProperty(['variablesResolutionMode']))) {
              throw new ServerlessError(
                `Cannot parse "${path.basename(
                  filePath
                )}": Approached a JS function resolver, confirm it's updated to work with a ` +
                  'new parser by setting "variablesResolutionMode: 20210219" in service config. ' +
                  'Falling back to old resolver',
                'NOT_SUPPORTED_JS_FUNCTION_SOURCE'
              );
            }
            try {
              isResolvedByFunction = true;
              return await result({ options, resolveConfigurationProperty });
            } catch (error) {
              if (error.code === 'MISSING_VARIABLE_DEPENDENCY') throw error;
              throw new ServerlessError(
                `Cannot resolve "${path.basename(filePath)}": Returned JS function errored with: ${
                  error && error.stack ? error.stack : error
                }`,
                'JS_FILE_FUNCTION_RESOLUTION_ERROR'
              );
            }
          }
          try {
            return await result;
          } catch (error) {
            throw new ServerlessError(
              `Cannot resolve "${path.basename(filePath)}": Received rejection: ${
                error && error.stack ? error.stack : error
              }`,
              'JS_FILE_RESOLUTION_ERROR'
            );
          }
        }
        default:
          // Anything else support as plain text
          return readFile(filePath);
      }
    })();

    if (!address) return { value: content };
    if (content == null) return { value: null };
    const propertyKeys = address.split('.');
    let result = content;
    for (const propertyKey of propertyKeys) {
      result = result[propertyKey];
      if (result == null) return { value: null };
      if (!isResolvedByFunction && isPlainFunction(result)) {
        if (!(await resolveConfigurationProperty(['variablesResolutionMode']))) {
          throw new ServerlessError(
            `Cannot resolve "${address}" out of "${path.basename(
              filePath
            )}": Resolved a JS function not confirmed to work with a new parser, ` +
              'falling back to old resolver',
            'FILE_CONTENT_RESOLUTION_ERROR'
          );
        }
        isResolvedByFunction = true;
        try {
          result = await result({ options, resolveConfigurationProperty });
        } catch (error) {
          if (error.code === 'MISSING_VARIABLE_DEPENDENCY') throw error;
          throw new ServerlessError(
            `Cannot resolve "${address}" out of "${path.basename(filePath)}": Received rejection: ${
              error && error.stack ? error.stack : error
            }`,
            'JS_FILE_PROPERTY_FUNCTION_RESOLUTION_ERROR'
          );
        }
      }
    }
    return { value: result };
  },
};
