
import React,  { useState }  from "react";
import { useNavigate } from 'react-router-dom';
import UseRequest from "../../hook/UseRequest";

const HandleNewUser = (props) => {

  const [ email, setEmail ] = useState('') ;
  const [password, setPassword] = useState('');
  const { doRequest, errors } = UseRequest({
    url: '/api/auth/new',
    method: 'post',
    body: {
        email, password
    },
    onSuccess: () => {
      navigate('/');
      props.callback();
    }
});

  const navigate = useNavigate();

  const onSubmit = async (event) => {
    event.preventDefault();

    doRequest();
    // await axios.post('/api/auth/new', {email, password }).then((response) => {
    //   navigate('/', {replace: true});
    // });
    // callback();
  }

  return <div className="card auth-card">
    <div className="card-body">
      <h1 className="h4 mb-3">Sign up</h1> 
      <form onSubmit={onSubmit}>
        <div className="form-group mb-2">
            <label>Email Address</label>
            <input value={email} onChange={e => setEmail(e.target.value)} className="form-control"/>
        </div>
        <div className="form-group mb-3">
            <label>Password</label>
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" className="form-control"/>
        </div>
        {errors}
        <button className="btn auth-submit w-100">Sign Up</button>
      </form>
    </div>
  </div>;
};

export default HandleNewUser;