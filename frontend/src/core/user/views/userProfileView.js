// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require){
  var Backbone = require('backbone');
  var Handlebars = require('handlebars');
  var OriginView = require('coreJS/app/views/originView');
  var Origin = require('coreJS/app/origin');

  var UserProfileView = OriginView.extend({
    tagName: 'div',
    className: 'user-profile',

    events: {
      'keyup #password': 'onPasswordKeyup',
      'keyup #passwordText': 'onPasswordTextKeyup',
      'click .toggle-password': 'togglePasswordView',
      'click a.change-password': 'togglePassword'
    },

    preRender: function() {
      this.listenTo(Origin, 'userProfileSidebar:views:save', this.saveUser);
      this.listenTo(this.model, 'invalid', this.handleValidationError);
      this.listenTo(this.model, 'change:_isNewPassword', this.togglePasswordUI);

      this.model.set('_isNewPassword', false);

      // data hasn't synced yet, do render when we're ready
      if(this.model.isNew()) {
        this.listenToOnce(this.model, 'change', this.render);
      }
    },

    postRender: function() {
      this.setViewToReady();
    },

    handleValidationError: function(model, error) {
      Origin.trigger('sidebar:resetButtons');
      if (error && _.keys(error).length !== 0) {
        _.each(error, function(value, key) { this.$('#' + key + 'Error').text(value); }, this);
        this.$('.error-text').removeClass('display-none');
      }
    },

    togglePassword: function(e) {
      e && e.preventDefault();
      // convert to bool and invert
      this.model.set('_isNewPassword', !!!this.model.get('_isNewPassword'));
    },

    togglePasswordUI: function(model, showPaswordUI) {
      var formSelector = 'div.change-password-section .form-group .inner';
      var buttonSelector = '.change-password';

      if (showPaswordUI) {
        this.$(formSelector).removeClass('display-none');
        this.$(buttonSelector).text(window.polyglot.t('app.undochangepassword'));
      } else {
        this.$(buttonSelector).text(window.polyglot.t('app.changepassword'));
        this.$(formSelector).addClass('display-none');

        this.$('#password').val('').removeClass('display-none');
        this.$('#passwordText').val('').addClass('display-none');
        this.$('.toggle-password i').addClass('fa-eye').removeClass('fa-eye-slash');

        this.$('.toggle-password').addClass('display-none');
        this.$('#passwordError').html('');

        this.model.set('password', '');
      }
    },

    togglePasswordView: function(e) {
      e && e.preventDefault();

      this.$('#passwordText').toggleClass('display-none');
      this.$('#password').toggleClass('display-none');
      this.$('.toggle-password i').toggleClass('fa-eye').toggleClass('fa-eye-slash');
    },

    indicatePasswordStrength: function(e) {
      var password = $('#password').val();
      var $passwordStrength = $('#passwordError');
      // Must have capital letter, numbers and lowercase letters
      var strongRegex = new RegExp("^(?=.{8,})(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*\\W).*$", "g");
      // Must have either capitals and lowercase letters or lowercase and numbers
      var mediumRegex = new RegExp("^(?=.{7,})(((?=.*[A-Z])(?=.*[a-z]))|((?=.*[A-Z])(?=.*[0-9]))|((?=.*[a-z])(?=.*[0-9]))).*$", "g");
      // Must be at least 8 characters long
      var okRegex = new RegExp("(?=.{8,}).*", "g");

      if (okRegex.test(password) === false) {
        var classes = 'alert alert-error';
        var htmlText = window.polyglot.t('app.validationlength', { length: 8 });
      } else if (strongRegex.test(password)) {
        var classes = 'alert alert-success';
        var htmlText = window.polyglot.t('app.passwordindicatorstrong');
      } else if (mediumRegex.test(password)) {
        var classes = 'alert alert-info';
        var htmlText = window.polyglot.t('app.passwordindicatormedium');
      } else {
        var classes = 'alert alert-info';
        var htmlText = window.polyglot.t('app.passwordindicatorweak');
      }

      $passwordStrength.removeClass().addClass(classes).html(htmlText);
    },

    saveUser: function() {
      this.$('.error-text').addClass('display-none');

      var toChange = {
        'firstName': self.$('#firstName').val().trim(),
        'lastName': self.$('#lastName').val().trim()
        // 'email': self.$('#email').val().trim()
      };
      if (this.model.get('_isNewPassword')) {
        toChange.password = self.$('#password').val();
      } else {
        this.model.unset('password');
      }

      this.model.save(toChange, {
        error: function(model, response, optinos) {
          Origin.trigger('sidebar:resetButtons');
          Origin.Notify.alert({
            type: 'error',
            text: window.polyglot.t('app.errorgeneric')
          });
        },
        success: function(model, response, options) {
          Backbone.history.history.back();
          Origin.trigger('user:updated');
          Origin.trigger('editingOverlay:views:hide');
        }
      });
    },

    onPasswordKeyup: function(e) {
      if(this.$('#password').val().length > 0) {
        this.$('#passwordText').val(this.$('#password').val());
        this.indicatePasswordStrength();
        this.$('.toggle-password').removeClass('display-none');
      } else {
        this.$('.toggle-password').addClass('display-none');
      }
    },

    onPasswordTextKeyup: function(e) {
    }
  }, {
    template: 'userProfile'
  });

  return UserProfileView;
});
