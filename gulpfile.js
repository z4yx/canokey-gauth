'use strict';

var gulp = require('gulp');
var gutil = require('gulp-util');
var ts = require("gulp-typescript");
var browserify = require("browserify");
var vinyl_source = require('vinyl-source-stream');
var tsify = require("tsify");
var tsProject = ts.createProject("tsconfig.json");
// var jshint = require('gulp-jshint');
var zip = require('gulp-zip');

var log = gutil.log;
var codeFiles = ['js/**/*.js', '!test/**/*.js', '!node_modules/**'];
var testFiles = ['test/**/*.js'];

// gulp.task("tsc", function () {
//   return tsProject.src()
//     .pipe(tsProject())
//     .js.pipe(gulp.dest("build"));
// });

gulp.task("tsc", function () {
  return browserify({
    basedir: '.',
    debug: true,
    entries: ['src/gauth-api.ts'],
    cache: {},
    packageCache: {}
  })
    .plugin(tsify)
    // .transform('babelify', {
    //   presets: ['es2015'],
    //   extensions: ['.ts']
    // })
    .bundle()
    .pipe(vinyl_source('bundle.js'))
    .pipe(gulp.dest("js"));
});

// gulp.task('lint', function(){
//   log('Linting Files');
//   gulp.src(codeFiles)
//     .pipe(jshint('.jshintrc'))
//     .pipe(jshint.reporter('default'))
//     .pipe(jshint.reporter('fail'));
// });

gulp.task('watch', function(){
  log('Watching Files');
  gulp.watch(['src/*.ts'], gulp.series('tsc'));
});

gulp.task('makepkg', function () {
  return gulp.src(['**', '!node_modules/**', '!gauth.zip',
      '!gulpfile.js', '!package.json', '!README.md']).
    pipe(zip('gauth.zip')).
    pipe(gulp.dest('.'));
});

// gulp.task('default', ['tsc']);
