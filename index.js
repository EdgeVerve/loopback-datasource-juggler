/*
©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary), Bangalore, India. All Rights Reserved.
The EdgeVerve proprietary software program ("Program"), is protected by copyrights laws, international treaties and other pending or existing intellectual property rights in India, the United States and other countries.
The Program may contain/reference third party or open source components, the rights to which continue to remain with the applicable third party licensors or the open source community as the case may be and nothing here transfers the rights to the third party and open source components, except as expressly permitted.
Any unauthorized reproduction, storage, transmission in any form or by any means (including without limitation to electronic, mechanical, printing, photocopying, recording or  otherwise), or any distribution of this Program, or any portion of it, may result in severe civil and criminal penalties, and will be prosecuted to the maximum extent possible under the law.
*/
exports.ModelBuilder = exports.LDL = require('./lib/model-builder.js').ModelBuilder;
exports.DataSource = exports.Schema = require('./lib/datasource.js').DataSource;
exports.ModelBaseClass = require('./lib/model.js');
exports.GeoPoint = require('./lib/geo.js').GeoPoint;
exports.ValidationError = require('./lib/validations.js').ValidationError;

Object.defineProperty(exports, 'version', {
  get: function() {return require('./package.json').version;}
});

var commonTest = './test/common_test';
Object.defineProperty(exports, 'test', {
  get: function() {return require(commonTest);}
});

exports.Transaction = require('./lib/transaction-ex.js');
