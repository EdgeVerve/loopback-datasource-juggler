// This test written in mocha+should.js
var should = require('./init.js');

var db = getSchema();

describe('defaults', function () {
  var Server;

  before(function () {
    Server = db.define('Server', {
      host: String,
      port: {type: Number, default: 80},
      createdAt: {type: Date, default: '$now'}
    });
  });

  it('should apply defaults on new', function () {
    var s = new Server;
    s.port.should.equal(80);
  });

  it('should apply defaults on create', function (done) {
    Server.create(function (err, s) {
      s.port.should.equal(80);
      done();
    });
  });

  it('should apply defaults on read', function (done) {
    db.defineProperty('Server', 'host', {
      type: String,
      default: 'localhost'
    });
    Server.all(function (err, servers) {
      (new String('localhost')).should.equal(servers[0].host);
      done();
    });
  });

  it('should ignore defaults with limited fields', function (done) {
    Server.create({ host: 'localhost', port: 8080 }, function(err, s) {
      should.not.exist(err);
      s.port.should.equal(8080);
      Server.find({ fields: ['host'] }, function (err, servers) {
        servers[0].host.should.equal('localhost');
        servers[0].should.have.property('host');
        servers[0].should.have.property('port', undefined);
        done();
      });
    });
  });

  it('should apply defaults in upsert create', function (done) {
    Server.upsert({port: 8181 }, function(err, server) {
      should.not.exist(err);
      should.exist(server.createdAt);
      done();
    });
  });

  it('should preserve defaults in upsert update', function (done) {
    Server.findOne({}, function(err, server) {
      Server.upsert({id:server.id, port: 1337 }, function(err, s) {
        should.not.exist(err);
        (Number(1337)).should.equal(s.port);
        server.createdAt.should.eql(s.createdAt);
        done();
      });
    });
  });

});
