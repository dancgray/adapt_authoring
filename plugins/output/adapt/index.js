// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
/**
 * Adapt Output plugin
 */
var _ = require('underscore');
var adapt2html = require('adapt2html');
var archiver = require('archiver');
var assetmanager = require('../../../lib/assetmanager');
var async = require('async');
var configuration = require('../../../lib/configuration');
var Constants = require('../../../lib/outputmanager').Constants;
var exec = require('child_process').exec;
var crypto = require('crypto');
var database = require('../../../lib/database');
var filestorage = require('../../../lib/filestorage');
var fs = require('fs');
var fse = require('fs-extra');
var glob = require('glob');
var helpers = require('../../../lib/helpers');
var IncomingForm = require('formidable').IncomingForm;
var logger = require('../../../lib/logger');
var mkdirp = require('mkdirp');
var ncp = require('ncp').ncp;
var origin = require('../../../')();
var OutputPlugin = require('../../../lib/outputmanager').OutputPlugin;
var path = require('path');
var rimraf = require('rimraf');
var semver = require('semver');
var usermanager = require('../../../lib/usermanager');
var util = require('util');
var version = require('../../../version');


function AdaptOutput() {
}
util.inherits(AdaptOutput, OutputPlugin);

var self;

/**
* FUNCTION: Publish
* ------------------------------------------------------------------------------
*/
AdaptOutput.prototype.publish = function(courseId, isPreview, request, response, next) {
  var self = this;
  var resultObject = {};

  var user = usermanager.getCurrentUser();
  var tenantId = user.tenant._id;
  var outputJson = {};
  var isRebuildRequired = false;
  var themeName = '';
  var menuName = Constants.Defaults.MenuName;
  var customPluginName = user._id;

  // shorthand directories
  var FRAMEWORK_ROOT_FOLDER = path.join(configuration.tempDir, configuration.getConfig('masterTenantID'), Constants.Folders.Framework);
  var SRC_FOLDER = path.join(FRAMEWORK_ROOT_FOLDER, Constants.Folders.Source);
  var COURSES_FOLDER = path.join(FRAMEWORK_ROOT_FOLDER, Constants.Folders.AllCourses);
  var COURSE_FOLDER = path.join(COURSES_FOLDER, tenantId, courseId);
  var BUILD_FOLDER = path.join(COURSE_FOLDER, Constants.Folders.Build);

  async.series([
      // get an object with all the course data
      function(callback) {
        self.getCourseJSON(tenantId, courseId, function(err, data) {
          if (err) {
            return callback(err);
          }

          // Store off the retrieved collections
          outputJson = data;

          callback(null);
        });
      },
      //
      function(callback) {
        var temporaryThemeFolder = path.join(SRC_FOLDER, Constants.Folders.Theme, customPluginName);
        self.applyTheme(tenantId, courseId, outputJson, temporaryThemeFolder, function(err, appliedThemeName) {
          if (err) {
            return callback(err);
          }

          // Replace the theme in outputJson with the applied theme name.
          themeName = appliedThemeName;

          outputJson['config'][0]._theme = themeName;

          callback(null);
        });
      },
      function(callback) {
        self.sanitizeCourseJSON(outputJson, function(err, data) {
          if (err) {
            return callback(err);
          }

          // Update the JSON object
          outputJson = data;

          callback(null);
        });
      },
      function(callback) {
        self.buildFlagExists(path.join(BUILD_FOLDER, Constants.Filenames.Rebuild), function(err, exists) {
          if (err) {
            return callback(err);
          }

          isRebuildRequired = exists || request.query.force === 'true';

          callback(null);
        });
      },
      function(callback) {
        var temporaryThemeFolder = path.join(SRC_FOLDER, Constants.Folders.Theme, customPluginName);
        self.writeCustomStyle(tenantId, courseId, temporaryThemeFolder, function(err) {
          if (err) {
            return callback(err);
          }

          callback(null);
        });
      },
      function(callback) {
        var temporaryMenuFolder = path.join(SRC_FOLDER, Constants.Folders.Menu, customPluginName);
        self.applyMenu(tenantId, courseId, outputJson, temporaryMenuFolder, function(err, appliedMenuName) {
          if (err) {
            return callback(err);
          }

          menuName = appliedMenuName;

          callback(null);
        });
      },
      function(callback) {
        var assetsFolder = path.join(BUILD_FOLDER, Constants.Folders.Course, outputJson['config']._defaultLanguage, Constants.Folders.Assets);

        self.writeCourseAssets(tenantId, courseId, assetsFolder, outputJson, function(err, modifiedJson) {
          if (err) {
            return callback(err);
          }

          // Store the JSON with the new paths to assets
          outputJson = modifiedJson;

          callback(null);
        });
      },
      function(callback) {
        self.writeCourseJSON(outputJson, path.join(BUILD_FOLDER, Constants.Folders.Course), function(err) {
          if (err) {
            return callback(err);
          }

          callback(null);
        });
      },
      function(callback) {
        fs.exists(path.join(BUILD_FOLDER, Constants.Filenames.Main), function(exists) {
          if (!exists || isRebuildRequired) {
            logger.log('info', '3.1. Ensuring framework build exists');

            var args = [];
            var outputFolder = COURSE_FOLDER.replace(FRAMEWORK_ROOT_FOLDER + path.sep,'');

            // Append the 'build' folder to later versions of the framework
            if (semver.gte(semver.clean(version.adapt_framework), semver.clean('2.0.0'))) {
              outputFolder = path.join(outputFolder, Constants.Folders.Build);
            }

            args.push('--outputdir=' + outputFolder);
            args.push('--theme=' + themeName);
            args.push('--menu=' + menuName);

            logger.log('info', '3.2. Using theme: ' + themeName);
            logger.log('info', '3.3. Using menu: ' + menuName);

            var generateSourcemap = outputJson.config._generateSourcemap;
            var buildMode = generateSourcemap === true ? 'dev' : 'prod';

            logger.log('info', 'grunt server-build:' + buildMode + ' ' + args.join(' '));

            child = exec('grunt server-build:' + buildMode + ' ' + args.join(' '), {cwd: path.join(FRAMEWORK_ROOT_FOLDER)},
              function(error, stdout, stderr) {
                if (error !== null) {
                  logger.log('error', 'exec error: ' + error);
                  logger.log('error', 'stdout error: ' + stdout);
                  resultObject.success = true;
                  return callback(error, 'Error building framework');
                }

                if (stdout.length != 0) {
                  logger.log('info', 'stdout: ' + stdout);
                  resultObject.success = true;

                  // Indicate that the course has built successfully
                  origin.emit('previewCreated', tenantId, courseId, outputFolder);

                  return callback(null, 'Framework built OK');
                }

                if (stderr.length != 0) {
                  logger.log('error', 'stderr: ' + stderr);
                  resultObject.success = false;
                  return callback(stderr, 'Error (stderr) building framework!');
                }

                resultObject.success = true;
                return callback(null, 'Framework built');
              });
          } else {
            resultObject.success = true;
            callback(null, 'Framework already built, nothing to do')
          }
        });
      },
      function(callback) {
        self.clearBuildFlag(path.join(BUILD_FOLDER, Constants.Filenames.Rebuild), function(err) {
          callback(null);
        });
      },
      function(callback) {
        if (!isPreview) {
          // Now zip the build package
          var filename = path.join(COURSE_FOLDER, Constants.Filenames.Download);
          var zipName = helpers.slugify(outputJson['course'].title);
          var output = fs.createWriteStream(filename),
            archive = archiver('zip');

          output.on('close', function() {
            resultObject.filename = filename;
            resultObject.zipName = zipName;

            // Indicate that the zip file is ready for download
            origin.emit('zipCreated', tenantId, courseId, filename, zipName);

            callback();
          });
          archive.on('error', function(err) {
            logger.log('error', err);
            callback(err);
          });

          archive.pipe(output);

          archive.bulk([
            { expand: true, cwd: path.join(BUILD_FOLDER), src: ['**/*'] },
          ]).finalize();
        } else {
          // No download required -- skip this step
          callback();
        }
      }
    ], function(err) {
      if (err) {
        logger.log('error', err);
        return next(err);
      }
      return next(null, resultObject);
    });
};



/**
* FUNCTION: Import
* ------------------------------------------------------------------------------
*/

function ImportError(message, httpStatus) {
  this.message = message || "Course import failed";
  this.httpStatus = httpStatus || 500;
};
util.inherits(ImportError, Error);

/**
* Course import function
*/
AdaptOutput.prototype.import = require('./import');


/**
* FUNCTION: Export
* TODO need implementation notes
*      - metadata structure
*      - devMode param
* ------------------------------------------------------------------------------
*/

/**
* Global vars
* For access by the other funcs
*/

// directories
var FRAMEWORK_ROOT_DIR = path.join(configuration.tempDir, configuration.getConfig('masterTenantID'), Constants.Folders.Framework);
var COURSE_ROOT_DIR;
var EXPORT_DIR;

var courseId;
// the top-level callback
var next;
// used with _.omit when saving metadata
var blacklistedProps = [
  '__v',
  '_isDeleted',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  '_hasPreview'
];

AdaptOutput.prototype.export = function(pCourseId, devMode, request, response, pNext) {
  self = this;
  // store the params
  var currentUser = usermanager.getCurrentUser();
  COURSE_ROOT_DIR = path.join(FRAMEWORK_ROOT_DIR, Constants.Folders.AllCourses, currentUser.tenant._id, pCourseId);
  EXPORT_DIR = path.join(FRAMEWORK_ROOT_DIR, Constants.Folders.Exports, currentUser._id);
  courseId = pCourseId;
  next = pNext;

  // create the EXPORT_DIR if it isn't there
  fse.ensureDir(EXPORT_DIR, function(error) {
    if(error) {
      return next(error);
    }
    // export tasks vary based on type of export
    async.auto(devMode === 'true' ? {
      // dev export
      generateLatestBuild: generateLatestBuild,
      copyFrameworkFiles: ['generateLatestBuild', copyFrameworkFiles],
      copyCourseFiles: ['generateLatestBuild', copyCourseFiles]
    } : {
      // standard export
      generateMetadata: generateMetadata,
      copyCustomPlugins: ['generateMetadata', copyCustomPlugins],
      copyAssets: ['generateMetadata', copyAssets]
    }, zipExport);
  });

};

function generateLatestBuild(courseBuilt) {
  self.publish(courseId, true, null, null, courseBuilt);
};

/**
* Metadata functions
*/

// creates metadata.json file
function generateMetadata(generatedMetadata) {
  async.parallel([
    function(callback) {
      getPackageData(FRAMEWORK_ROOT_DIR, callback);
    },
    function(callback) {
      getCourseMetdata(courseId, callback);
    },
    function(callback) {
      getAssetMetadata(courseId, callback);
    },
    function(callback) {
      getPluginMetadata(courseId, callback);
    },
  ], function(error, results) {
    if(error) {
      return generatedMetadata(error);
    }
    metadata = _.reduce(results, function(memo,result){ return _.extend(memo,result); });
    fse.writeJson(path.join(EXPORT_DIR, Constants.Filenames.Metadata), metadata, { spaces:0 }, generatedMetadata);
  });
};


// pulls out relevant attributes from package.json
function getPackageData(frameworkDir, gotPackageJson) {
  fse.readJson(path.join(frameworkDir, Constants.Filenames.Package), function onJsonRead(error, packageJson) {
    gotPackageJson(null, _.pick(packageJson, 'version'));
  });
};

// rips all course data from the DB
function getCourseMetdata(courseId, gotCourseMetadata) {
  database.getDatabase(function(error, db) {
    if (error) {
      return callback(error);
    }
    // metadata structure
    var metadata = {
      course: {}
    };

    async.each(Object.keys(Constants.CourseCollections), function iterator(collectionType, doneIterator) {
      var criteria = collectionType === 'course' ? { _id: courseId } : { _courseId: courseId };
      db.retrieve(collectionType, criteria, {operators: { sort: { _sortOrder: 1}}}, function dbRetrieved(error, results) {
        if (error) {
          gotCourseMetadata(doneIterator);
        }
        // only store the _doc values
        var toSave = _.pluck(results,'_doc');
        // store data, remove blacklisted properties
        // TODO make sure we're only saving what we need
        _.each(toSave, function(item, index) { toSave[index] = _.omit(item, blacklistedProps); });
        metadata.course[collectionType] = toSave;

        doneIterator();
      });
    }, function doneEach(error) {
      gotCourseMetadata(error, metadata);
    });
  }, usermanager.getCurrentUser().tenant._id);
};

function getAssetMetadata(courseId, gotAssetMetadata) {
  // metadata structure
  var metadata = {
    assets: {},
    courseassets: []
  };
  origin.contentmanager.getContentPlugin('courseasset', function(error, plugin) {
    plugin.retrieve({ _courseId:courseId }, function(error, results) {
      if(error) {
        return gotAssetMetadata(error);
      }
      async.each(results, function iterator(courseasset, doneIterator) {
        origin.assetmanager.retrieveAsset({ _id:courseasset._assetId }, function(error, matchedAssets) {
          if(error) {
            return doneIterator(error);
          }
          if(!matchedAssets) {
            return doneIterator(new Error('No asset found with id: ' + courseasset._assetId));
          }
          if(matchedAssets.length > 1) {
            logger.log('info',"export.getAssetMetadata: multiple assets found with id", courseasset._assetId, "using first result");
          }
          var asset = matchedAssets[0];

          // would _.pick, but need to map some keys
          // TODO not ideal
          if(!metadata.assets[asset.filename]) {
            metadata.assets[asset.filename] = {
              "oldId": asset._id,
              "title": asset.title,
              "description": asset.description,
              "type": asset.mimeType,
              "size": asset.size
            };
          }
          // else console.log('Asset already stored:', asset.filename);

          // store the courseasset, omitting the blacklistedProps + _id
          var toOmit = blacklistedProps.concat([ "_id" ]);
          var courseassetData = _.omit(courseasset._doc, toOmit);
          metadata.courseassets.push(courseassetData);

          doneIterator();
        });
      }, function doneEach(error) {
        gotAssetMetadata(error, metadata);
      });
    });
  });
};

/**
* Generates:
* - A map for component types
* - List of plugins to include (i.e. plugins that have been manually updated,
*   or are completely custom)
*/
function getPluginMetadata(courseId, gotPluginMetadata) {
  /*
  * HACK there's got to be a way to get this info dynamically
  * We need:
  * - Content plugin name to see if it's already installed (so need plugin type)
  * - Plugin folder name to find plugin code (so need the plugin folder name -- maybe do this with a glob/search?)
  * (See Import.importPlugins for context)
  * For now, add map to metadata
  */
  var metadata = {
    pluginTypes: [
      { type: 'component', folder: 'components' },
      { type: 'extension', folder: 'extensions' },
      { type: 'menu',      folder: 'menu'       },
      { type: 'theme',     folder: 'theme'      }
    ],
    pluginIncludes: []
  };

  var includes;
  async.waterfall([
    function getIncludes(cb) {
      self.generateIncludesForCourse(courseId, cb);
    },
    function getDb(pIncludes, cb) {
      includes = pIncludes;
      database.getDatabase(cb);
    },
    function generateIncludes(db, cb) {
      async.each(metadata.pluginTypes, function iterator(pluginType, doneIterator) {
        db.retrieve(pluginType.type + 'type', { "isLocalPackage": true, "_isDeleted": false }, function gotTypeDoc(error, results) {
          if(error) {
            return cb(error);
          }
          async.each(results, function iterator(result, doneIterator2) {
            if(_.indexOf(includes, result.name) !== -1) {
              var data = _.extend(pluginType, { name: result.name });
              metadata.pluginIncludes.push(data);
            }
            doneIterator2();
          }, doneIterator);
        });
      }, cb);
    }
  ], function doneWaterfall(error) {
    gotPluginMetadata(error, metadata);
  });
};

/**
* Copy functions
*/

// copies relevant files in adapt_framework
function copyFrameworkFiles(filesCopied) {
  self.generateIncludesForCourse(courseId, function(error, includes) {
    if(error) {
      return includesGenerated(error);
    }
    // create list of includes
    for(var i = 0, count = includes.length; i < count; i++)
      includes[i] = '\/' + includes[i] + '(\/|$)';

    var includesRE = new RegExp(includes.join('|'));
    var excludesRE = new RegExp(/\.git\b|\.DS_Store|\/node_modules|\/courses\b|\/course\b|\/exports\b/);
    var pluginsRE = new RegExp('\/components\/|\/extensions\/|\/menu\/|\/theme\/');

    fse.copy(FRAMEWORK_ROOT_DIR, EXPORT_DIR, {
      filter: function(filePath) {
        var posixFilePath = filePath.replace(/\\/g, '/');
        var isIncluded = posixFilePath.search(includesRE) > -1;
        var isExcluded = posixFilePath.search(excludesRE) > -1;
        var isPlugin = posixFilePath.search(pluginsRE) > -1;

        // exclude any matches to excludesRE
        if(isExcluded) return false;
        // exclude any plugins not in includes
        else if(isPlugin) return isIncluded;
        // include everything else
        else return true;
      }
    }, function doneCopy(error) {
      if (error) {
        return filesCopied(error);
      }
      copyCourseFiles(filesCopied);
    });
  });
};

// uses the metadata list to include only relevant plugin files
function copyCustomPlugins(filesCopied) {
  var src = path.join(FRAMEWORK_ROOT_DIR, Constants.Folders.Source);
  var dest = path.join(EXPORT_DIR, Constants.Folders.Plugins);
  async.each(metadata.pluginIncludes, function iterator(plugin, cb) {
    var pluginDir = path.join(src, plugin.folder, plugin.name);
    fse.copy(pluginDir, path.join(dest, plugin.name), cb);
  }, filesCopied);
};

// copies everything in the course folder
function copyCourseFiles(filesCopied) {
  var source = path.join(COURSE_ROOT_DIR, Constants.Folders.Build, Constants.Folders.Course);
  var dest = path.join(EXPORT_DIR, Constants.Folders.Source, Constants.Folders.Course);
  fse.ensureDir(dest, function(error) {
    if (error) {
      return filesCopied(error);
    }
    fse.copy(source, dest, filesCopied);
  });
};

// copies used assets directly from the data folder
function copyAssets(assetsCopied) {
  var dest = path.join(EXPORT_DIR, Constants.Folders.Assets);
  fse.ensureDir(dest, function(error) {
    if (error) {
      return filesCopied(error);
    }
    async.each(Object.keys(metadata.assets), function iterator(assetKey, doneIterator) {
      var oldId = metadata.assets[assetKey].oldId;
      origin.assetmanager.retrieveAsset({ _id:oldId }, function(error, results) {
        if(error) {
          return doneIterator(error);
        }
        filestorage.getStorage(results[0].repository, function gotStorage(error, storage) {
          var srcPath = storage.resolvePath(results[0].path);
          var destPath = path.join(dest, assetKey);
          fse.copy(srcPath, destPath, doneIterator);
        });
      });
    }, assetsCopied);
  });
};

/**
* post-processing
*/

function zipExport(error) {
  if(error) {
    return next(error);
  }
  var archive = archiver('zip');
  var output = fse.createWriteStream(EXPORT_DIR +  '.zip');
  archive.on('error', cleanUpExport);
  output.on('close', cleanUpExport);
  archive.pipe(output);
  archive.bulk([{ expand: true, cwd: EXPORT_DIR, src: ['**/*'] }]).finalize();
};

// remove the EXPORT_DIR, if there is one
function cleanUpExport(exportError) {
  fse.remove(EXPORT_DIR, function(removeError) {
    next(exportError || removeError);
  });
};

/**
* FUNCTION: Export HTML
* ------------------------------------------------------------------------------
*/
AdaptOutput.prototype.exportHtml = function(courseId, request, response, next) {
  var user = usermanager.getCurrentUser();
  var userId = user._id;
  var folders = Constants.Folders;
  var exportsDir = path.join(
    configuration.tempDir,
    configuration.getConfig('masterTenantID'),
    folders.Framework,
    folders.Exports
  );
  var destDir = path.join(exportsDir, userId);
  var destZip = path.join(exportsDir, userId + '.zip');
  var courseJsonDir;
  var outputJson = {};
  var resultObject = {};

  self = this;

  async.series([
    function(callback) {
      self.getCourseJSON(user.tenant._id, courseId, function(err, data) {
        if (err) {
          return callback(err);
        }

        outputJson = data;
        callback(null);
      });
    },
    function(callback) {
      self.sanitizeCourseJSON(outputJson, function(err, data) {
        if (err) {
          return callback(err);
        }

        outputJson = data;
        callback(null);
      });
    },
    function(callback) {
      self.writeCourseJSON(outputJson, destDir, callback);
    },
    function(callback) {
      courseJsonDir = path.join(destDir, outputJson.config._defaultLanguage);
      adapt2html.main(courseJsonDir, function(err) { callback(err || null); });
    },
    function(callback) {
      var archive = archiver('zip');
      var output = fse.createWriteStream(destZip);

      archive.on('error', function(err) {
        logger.log('error', err);
        callback(err);
      });

      output.on('close', function() {
        resultObject.courseTitle = outputJson.course.title;
        callback(null);
      });

      archive.pipe(output);

      archive.bulk([
        { expand: true, cwd: path.join(courseJsonDir, 'adapt2html'), src: ['**/*'] }
      ]).finalize();
    }
  ], function(err) {
    fse.remove(destDir, function(removeErr) {
      var error = err || removeErr;

      error ? next(error) : next(null, resultObject);
    });
  });
};

/**
 * Module exports
 *
 */

exports = module.exports = AdaptOutput;
