import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from "axios";

const HandleLogOut = ({callback}) => {
  const navigate = useNavigate();

  useEffect(() => {
    const doRequest = async () => {
      await axios.post('/api/auth/logout').then(() => {
        navigate('/');
        callback();
      });
    };

    doRequest();
  },[navigate, callback]);

  
  return <div>Logging you out...</div>;
};

export default HandleLogOut;